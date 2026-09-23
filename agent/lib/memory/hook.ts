import type { HookContext, HookDefinition } from "eve/hooks";

import { record } from "../activity";
import { operator } from "../session";
import { sessionState } from "../session-state";
import { sessionBinding } from "../computer/screens";
import { capture, type CaptureMode, defaultDeps } from "./capture";
import { learnFromDenial } from "./outcomes";
import { jobOf, trace } from "./provider";
import { fieldFor, type MemorySlot } from "./store";

/**
 * Remembering, driven from the event stream.
 *
 * The exchange is gathered as it happens: what the person said from
 * `message.received`, what came back from `message.completed`, and, on a job,
 * what the tools returned from `action.result`. When the turn completes, the
 * gatekeeper pipeline in `capture.ts` decides what to keep.
 *
 * This is a hook rather than the provider's own capture handler because eve
 * 0.58 emits `turn.completed` without the settled history, so that handler is
 * never dispatched. Hooks are observe-only and at-least-once; capture is
 * idempotent per turn, and a failure here never touches the turn.
 */

interface Exchange {
  person: string[];
  reply: string[];
  tools: string[];
  turnId: string | null;
}

const MAX_TOOL_NOTE = 600;
const MAX_TRANSCRIPT = 8_000;

const fresh = (): Exchange => ({ person: [], reply: [], tools: [], turnId: null });

/** A tool result, flattened to a line the extractor can read. */
function describeResult(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const row = result as { toolName?: unknown; name?: unknown; output?: unknown; result?: unknown; error?: unknown };
  const name = typeof row.toolName === "string" ? row.toolName : typeof row.name === "string" ? row.name : "tool";
  const payload = row.output ?? row.result ?? row.error;
  if (payload === undefined) return null;
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  if (typeof text !== "string" || text.trim() === "") return null;
  return `[${name}] ${text.slice(0, MAX_TOOL_NOTE)}`;
}

interface Asked {
  readonly toolName: string;
  readonly prompt: string;
  readonly input: unknown;
}

export function memoryCaptureHook(mode: CaptureMode): HookDefinition {
  const slot: MemorySlot = mode === "conversation" ? "profile" : "craft";
  const exchanges = sessionState<Exchange>();
  /** Approvals a job asked for, by request id, so a decline can be read back. */
  const asked = sessionState<Map<string, Asked>>();
  const current = (ctx: HookContext): Exchange => {
    const existing = exchanges.get(ctx.session.id);
    if (existing !== undefined) return existing;
    const started = fresh();
    exchanges.set(ctx.session.id, started);
    return started;
  };

  return {
    events: {
      "turn.started"(event, ctx) {
        // A new turn starts a new exchange; a job's brief arrives as its first turn's message.
        const exchange = current(ctx);
        if (exchange.turnId !== null && exchange.turnId !== event.data.turnId) exchanges.set(ctx.session.id, { ...fresh(), turnId: event.data.turnId });
        else exchange.turnId = event.data.turnId;
      },
      "message.received"(event, ctx) {
        const auth = ctx.session.auth.current ?? ctx.session.auth.initiator;
        if (mode === "conversation" && auth?.principalType !== "user") return;
        if (/^Background task /.test(event.data.message) || event.data.message.startsWith("Routine report:")) return;
        current(ctx).person.push(event.data.message);
      },
      "message.completed"(event, ctx) {
        if (event.data.message !== null && event.data.message.trim() !== "") current(ctx).reply.push(event.data.message);
      },
      "action.result"(event, ctx) {
        if (mode !== "job") return;
        const note = describeResult(event.data.result);
        if (note !== null) current(ctx).tools.push(note);
      },
      "input.requested"(event, ctx) {
        if (mode !== "job") return;
        const pending = asked.get(ctx.session.id) ?? new Map<string, Asked>();
        for (const request of event.data.requests) {
          if (request.kind !== "tool-approval") continue;
          pending.set(request.requestId, { toolName: request.action?.toolName ?? "a tool", prompt: request.prompt, input: request.action?.input });
        }
        asked.set(ctx.session.id, pending);
      },
      async "approval.settled"(event, ctx) {
        if (mode !== "job" || event.data.outcome !== "cancelled") return;
        const request = asked.get(ctx.session.id)?.get(event.data.requestId);
        if (request === undefined) return;
        asked.get(ctx.session.id)?.delete(event.data.requestId);
        const workspaceId = operator(ctx).workspaceId;
        try {
          const binding = await sessionBinding(workspaceId, ctx.session.id);
          if (binding === null) return;
          await learnFromDenial(workspaceId, { jobId: binding.jobId, botId: binding.botId, requestId: event.data.requestId, ...request });
        } catch (error) {
          await trace(workspaceId, "craft", "failed", `denial: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
      async "turn.completed"(event, ctx) {
        const exchange = exchanges.get(ctx.session.id);
        exchanges.delete(ctx.session.id);
        if (exchange === undefined) return;
        const who = operator(ctx);
        const workspaceId = who.workspaceId;
        try {
          if (who.automated) {
            await trace(workspaceId, slot, "skipped", "automated turn");
            return;
          }
          const person = exchange.person.join("\n").trim();
          if (person === "") {
            await trace(workspaceId, slot, "skipped", "no message from a person this turn");
            return;
          }
          const job = mode === "job" ? await jobOf(workspaceId, [{ role: "user", content: person }]) : null;
          if (mode === "job" && job === null) {
            await trace(workspaceId, slot, "skipped", "no job id in the brief");
            return;
          }
          const reply = mode === "conversation" ? exchange.reply.join("\n") : [...exchange.reply, ...exchange.tools].join("\n").slice(-MAX_TRANSCRIPT);
          const source =
            mode === "conversation"
              ? { who: "auto" as const, room: who.room }
              : { who: "auto" as const, name: job?.botName, room: who.room, jobId: job?.jobId ?? null };
          await trace(workspaceId, slot, "capturing", `${person.length} chars from the person, ${reply.length} back`);
          const result = await capture(
            { workspaceId, mode, person, reply, source, operationId: `${ctx.session.id}:${event.data.turnId}` },
            defaultDeps(workspaceId),
          );
          await trace(
            workspaceId,
            slot,
            "done",
            `gate=${result.gate} proposed=${result.proposed} saved=${result.saved.length} updated=${result.updated.length} retired=${result.retired.length} fields=${result.fields.length} confirmed=${result.confirmed.length}${result.raw === undefined ? "" : ` raw=${result.raw}`}${result.error === undefined ? "" : ` extractor failed: ${result.error}`}`,
          );
          const changed = [...result.saved, ...result.updated, ...result.retired];
          if (changed.length + result.fields.length === 0) return;
          const parts = [
            result.fields.length === 0 ? null : `Noted: ${result.fields.map((change) => `${fieldFor(change.slot, change.field)?.label ?? change.field} is ${change.value}`).join(" · ")}`,
            result.saved.length === 0 ? null : `Remembered: ${result.saved.map((entry) => entry.text).join(" · ")}`,
            result.updated.length === 0 ? null : `Updated: ${result.updated.map((entry) => entry.text).join(" · ")}`,
            result.retired.length === 0 ? null : `No longer true: ${result.retired.map((entry) => entry.text).join(" · ")}`,
          ].filter((part): part is string => part !== null);
          await record({
            workspaceId,
            kind: "memory.saved",
            botId: job?.botId ?? null,
            jobId: job?.jobId ?? null,
            text: parts.join(" — "),
            data: { slots: [...new Set([...changed, ...result.fields].map((item) => item.slot))], ids: changed.map((entry) => entry.id), fields: result.fields.map((change) => change.field), gate: result.gate },
          });
        } catch (error) {
          await trace(workspaceId, slot, "failed", error instanceof Error ? `${error.name}: ${error.message}` : String(error));
        }
      },
    },
  };
}
