import { describe, expect, it } from "vitest";

import { isTruncatedStream, tolerateTruncation } from "../agent/lib/steady";

/** The complaint the OpenAI-compatible provider raises when a stream ends without its last chunk. */
const truncated = () => Object.assign(new Error("Response stream ended without a finish reason."), { name: "AI_InvalidResponseDataError" });

function streamOf(parts: unknown[], failWith?: unknown): ReadableStream<never> {
  return new ReadableStream({
    pull(controller) {
      if (parts.length > 0) {
        controller.enqueue(parts.shift() as never);
        return;
      }
      if (failWith !== undefined) controller.error(failWith);
      else controller.close();
    },
  });
}

async function collect(stream: ReadableStream<unknown>): Promise<Array<{ type: string } & Record<string, unknown>>> {
  const out: Array<{ type: string } & Record<string, unknown>> = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value as { type: string } & Record<string, unknown>);
  }
}

describe("a stream the endpoint drops early", () => {
  it("recognises the provider's complaint and nothing else", () => {
    expect(isTruncatedStream(truncated())).toBe(true);
    expect(isTruncatedStream(new Error("Response stream ended without a finish reason."))).toBe(true);
    expect(isTruncatedStream(new Error("fetch failed"))).toBe(false);
    expect(isTruncatedStream(null)).toBe(false);
  });

  it("ends cleanly on text already received, closing what was left open", async () => {
    const parts = await collect(
      tolerateTruncation(
        streamOf([{ type: "stream-start", warnings: [] }, { type: "text-start", id: "t1" }, { type: "text-delta", id: "t1", delta: "Inbox has 3 unread" }], truncated()) as never,
      ),
    );
    expect(parts.map((part) => part.type)).toEqual(["stream-start", "text-start", "text-delta", "text-end", "finish"]);
    const finish = parts.at(-1)!;
    expect(finish.finishReason).toEqual({ unified: "stop", raw: "stream-truncated" });
    expect(finish.providerMetadata).toEqual({ custom: { truncatedStream: true } });
  });

  it("finishes as tool-calls when a complete call was received", async () => {
    const parts = await collect(
      tolerateTruncation(
        streamOf(
          [
            { type: "tool-input-start", id: "c1", toolName: "browse" },
            { type: "tool-input-delta", id: "c1", delta: '{"url":"mail.google.com"}' },
            { type: "tool-input-end", id: "c1" },
            { type: "tool-call", toolCallId: "c1", toolName: "browse", input: '{"url":"mail.google.com"}' },
          ],
          truncated(),
        ) as never,
      ),
    );
    expect(parts.at(-1)!.finishReason).toEqual({ unified: "tool-calls", raw: "stream-truncated" });
  });

  it("still fails when nothing was received, when a tool call was cut mid-arguments, or on any other error", async () => {
    await expect(collect(tolerateTruncation(streamOf([{ type: "stream-start", warnings: [] }], truncated()) as never))).rejects.toThrow(/finish reason/);
    await expect(
      collect(
        tolerateTruncation(
          streamOf([{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "x" }, { type: "tool-input-start", id: "c1", toolName: "browse" }], truncated()) as never,
        ),
      ),
    ).rejects.toThrow(/finish reason/);
    await expect(
      collect(tolerateTruncation(streamOf([{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "x" }], new Error("fetch failed")) as never)),
    ).rejects.toThrow(/fetch failed/);
  });

  it("passes a whole stream through untouched", async () => {
    const whole = [{ type: "stream-start", warnings: [] }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "ok" }, { type: "text-end", id: "t" }, { type: "finish", finishReason: { unified: "stop" }, usage: {} }];
    const parts = await collect(tolerateTruncation(streamOf([...whole]) as never));
    expect(parts).toEqual(whole);
  });

  it("reads the drop when the provider reports it as an error part, as the OpenAI-compatible one does", async () => {
    const parts = await collect(
      tolerateTruncation(streamOf([{ type: "text-start", id: "t1" }, { type: "text-delta", id: "t1", delta: "Done." }, { type: "error", error: truncated() }]) as never),
    );
    expect(parts.map((part) => part.type)).toEqual(["text-start", "text-delta", "text-end", "finish"]);
  });

  it("asks again when the stream drops before the model said anything, and only so often", async () => {
    let asked = 0;
    const again = async () => {
      asked += 1;
      return streamOf([{ type: "stream-start", warnings: [] }, { type: "text-start", id: "t2" }, { type: "text-delta", id: "t2", delta: "Here." }, { type: "text-end", id: "t2" }, { type: "finish", finishReason: { unified: "stop" } }]) as never;
    };
    const parts = await collect(
      tolerateTruncation(streamOf([{ type: "stream-start", warnings: [] }, { type: "reasoning-start", id: "r1" }, { type: "error", error: truncated() }]) as never, again),
    );
    expect(asked).toBe(1);
    // The first try's thinking is closed, and the second's opening is not passed on twice.
    expect(parts.map((part) => part.type)).toEqual(["stream-start", "reasoning-start", "reasoning-end", "text-start", "text-delta", "text-end", "finish"]);

    const always = async () => streamOf([{ type: "error", error: truncated() }]) as never;
    const gaveUp = await collect(tolerateTruncation(streamOf([{ type: "error", error: truncated() }]) as never, always, 2));
    expect(gaveUp.map((part) => part.type)).toEqual(["error"]);
  });
});
