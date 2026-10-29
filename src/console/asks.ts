/**
 * What a thread's approval and question cards draw: a person's step, in the
 * shape the cards were written for. eve 0.84 reports these as interactions
 * (`interaction.opened`, `interaction.settled`); `askOf` and `resolutionOf`
 * turn those into it, so the cards read the same as before. A request is
 * named by its `requestId`, which is the interaction's id.
 */

export interface InputOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly style?: "primary" | "danger" | "default" | (string & {});
}

export interface InputRequest {
  readonly requestId: string;
  /** `tool-approval`, `question`, `session-limit` (eve's budget prompt), or another kind eve adds. */
  readonly kind: string;
  readonly prompt: string;
  readonly title?: string;
  readonly options?: readonly InputOption[];
  readonly allowFreeform?: boolean;
  /** For an approval: the tool that asks, and what it was called with. */
  readonly action?: { readonly toolName: string; readonly input?: Readonly<Record<string, unknown>> };
  /** For a request a Bot at work asked, relayed into this thread: its id in the Bot's own session. */
  readonly originId?: string;
}

export interface InputResolution {
  readonly requestId: string;
  readonly kind: string;
  /** `approved`, `denied`, `answered`, or `ignored` (withdrawn, interrupted, expired). */
  readonly outcome: string;
  readonly response?: { readonly optionId?: string; readonly text?: string };
}

/** A tool call as the thread saw it requested. */
export interface SeenCall {
  readonly name: string;
  readonly input?: unknown;
}

interface Opened {
  readonly interactionId: string;
  readonly subject: { readonly callId?: string };
  readonly request: {
    readonly kind: string;
    readonly prompt: string;
    readonly title?: string;
    readonly options?: readonly InputOption[];
    readonly allowFreeform?: boolean;
  };
  readonly origin?: { readonly interactionId: string; readonly call?: { readonly name: string; readonly input?: unknown } };
}

interface Settled {
  readonly interactionId: string;
  readonly outcome: string;
  readonly response?: Readonly<Record<string, unknown>>;
}

const KINDS: Readonly<Record<string, string>> = { approval: "tool-approval", budget: "session-limit" };

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/**
 * The card for an `interaction.opened` fact. An approval names the call it is
 * about: a relayed one carries it in `origin.call`; this thread's own is the
 * call `calls` saw requested.
 */
export function askOf(data: Opened, calls: ReadonlyMap<string, SeenCall>): InputRequest {
  const call = data.origin?.call ?? (data.subject.callId === undefined ? undefined : calls.get(data.subject.callId));
  const input = asRecord(call?.input);
  return {
    requestId: data.interactionId,
    kind: KINDS[data.request.kind] ?? data.request.kind,
    prompt: data.request.prompt,
    ...(data.request.title === undefined ? {} : { title: data.request.title }),
    ...(data.request.options === undefined ? {} : { options: data.request.options }),
    ...(data.request.allowFreeform === undefined ? {} : { allowFreeform: data.request.allowFreeform }),
    ...(call === undefined ? {} : { action: { toolName: call.name, ...(input === undefined ? {} : { input }) } }),
    ...(data.origin === undefined ? {} : { originId: data.origin.interactionId }),
  };
}

/** How an `interaction.settled` fact reads on its card. */
export function resolutionOf(request: Pick<InputRequest, "kind"> | undefined, data: Settled): InputResolution {
  const optionId = typeof data.response?.optionId === "string" ? data.response.optionId : undefined;
  const text = typeof data.response?.text === "string" ? data.response.text : undefined;
  const kind = request?.kind ?? "question";
  const outcome =
    data.outcome === "accepted"
      ? kind === "tool-approval"
        ? optionId === "deny"
          ? "denied"
          : "approved"
        : "answered"
      : data.outcome === "declined"
        ? "denied"
        : "ignored";
  return {
    requestId: data.interactionId,
    kind,
    outcome,
    ...(optionId === undefined && text === undefined ? {} : { response: { ...(optionId === undefined ? {} : { optionId }), ...(text === undefined ? {} : { text }) } }),
  };
}
