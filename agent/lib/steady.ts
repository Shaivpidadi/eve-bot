import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";

/**
 * A model stream that survives an endpoint hanging up early.
 *
 * Local servers such as Ollama sometimes close a streaming response without
 * the final chunk that carries the finish reason: after a long generation,
 * under load, or when a connection is reset. The AI SDK treats that as a
 * malformed response and fails the whole turn, and eve parks the session; a
 * job that was one answer from done is lost, along with everything the
 * model had already said in that turn.
 *
 * This middleware reads the provider's stream itself. When the stream errors
 * with exactly that complaint, and the model had already produced text or a
 * complete tool call, it closes any open parts and ends the stream with a
 * synthesized finish, so the turn completes on what was received. When it
 * errors before the model produced anything, the step is asked for again. A
 * stream cut in the middle of a tool call's arguments cannot be completed and
 * still fails, as does any other error.
 */

type StreamResult = Awaited<ReturnType<Parameters<NonNullable<LanguageModelMiddleware["wrapStream"]>>[0]["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer T> ? T : never;
type WrappableModel = Parameters<typeof wrapLanguageModel>[0]["model"];

/** The error the OpenAI-compatible provider raises when a stream ends without its final chunk. */
export function isTruncatedStream(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { message } = error as { message?: unknown };
  return typeof message === "string" && /stream ended without a finish reason/i.test(message);
}

const NO_USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  raw: undefined,
};

/**
 * The stream, ended cleanly if the provider drops it after real content, and
 * asked for again (`again`, at most `retries` times) if it drops before the
 * model said anything at all: nothing has been acted on yet, so a fresh
 * request is safe. The provider reports the drop either by failing the stream
 * or as an `error` part in it; both are read here.
 */
export function tolerateTruncation(
  stream: ReadableStream<StreamPart>,
  again?: () => Promise<ReadableStream<StreamPart>>,
  retries = 2,
): ReadableStream<StreamPart> {
  let reader = stream.getReader();
  let left = again === undefined ? 0 : retries;
  // A stream asked for again starts over; its opening parts were already passed on once.
  let restarted = false;
  const openText = new Set<string>();
  const openReasoning = new Set<string>();
  const openToolInputs = new Set<string>();
  let finished = false;
  let content = false;
  let toolCalls = 0;

  const track = (part: StreamPart) => {
    switch (part.type) {
      case "text-start":
        openText.add(part.id);
        break;
      case "text-delta":
        if (part.delta !== "") content = true;
        break;
      case "text-end":
        openText.delete(part.id);
        break;
      case "reasoning-start":
        openReasoning.add(part.id);
        break;
      case "reasoning-end":
        openReasoning.delete(part.id);
        break;
      case "tool-input-start":
        openToolInputs.add(part.id);
        break;
      case "tool-input-end":
        openToolInputs.delete(part.id);
        break;
      case "tool-call":
        openToolInputs.delete(part.toolCallId);
        toolCalls += 1;
        break;
      case "finish":
        finished = true;
        break;
      default:
        break;
    }
  };

  /** What to do about a drop: finish on what came, ask again, or pass the error on. */
  async function dropped(controller: ReadableStreamDefaultController<StreamPart>, error: unknown, asPart: boolean): Promise<"retried" | "done"> {
    const truncated = !finished && isTruncatedStream(error) && openToolInputs.size === 0;
    if (truncated && (content || toolCalls > 0)) {
      for (const id of openReasoning) controller.enqueue({ type: "reasoning-end", id } as StreamPart);
      for (const id of openText) controller.enqueue({ type: "text-end", id } as StreamPart);
      controller.enqueue({
        type: "finish",
        finishReason: { unified: toolCalls > 0 ? "tool-calls" : "stop", raw: "stream-truncated" },
        usage: NO_USAGE,
        providerMetadata: { custom: { truncatedStream: true } },
      } as StreamPart);
      controller.close();
      return "done";
    }
    if (truncated && left > 0 && again !== undefined) {
      left -= 1;
      // What it was thinking is closed; the new request thinks again.
      for (const id of openReasoning) controller.enqueue({ type: "reasoning-end", id } as StreamPart);
      for (const id of openText) controller.enqueue({ type: "text-end", id } as StreamPart);
      openReasoning.clear();
      openText.clear();
      void reader.cancel().catch(() => undefined);
      reader = (await again()).getReader();
      restarted = true;
      return "retried";
    }
    if (asPart) {
      controller.enqueue({ type: "error", error } as StreamPart);
      controller.close();
    } else controller.error(error);
    return "done";
  }

  return new ReadableStream<StreamPart>({
    async pull(controller) {
      for (;;) {
        let read: ReadableStreamReadResult<StreamPart>;
        try {
          read = await reader.read();
        } catch (error) {
          if ((await dropped(controller, error, false)) === "retried") continue;
          return;
        }
        if (read.done) {
          controller.close();
          return;
        }
        const part = read.value;
        if (part.type === "error") {
          if ((await dropped(controller, part.error, true)) === "retried") continue;
          return;
        }
        if (restarted && (part.type === "stream-start" || part.type === "response-metadata")) continue;
        track(part);
        controller.enqueue(part);
        return;
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

export function steadyModel(model: WrappableModel): WrappableModel {
  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v4",
    async wrapStream({ doStream }) {
      const result = await doStream();
      return { ...result, stream: tolerateTruncation(result.stream, async () => (await doStream()).stream) };
    },
  };
  return wrapLanguageModel({ model, middleware });
}
