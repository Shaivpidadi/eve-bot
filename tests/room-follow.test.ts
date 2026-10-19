import { afterEach, describe, expect, it, vi } from "vitest";

import { RoomStore } from "../src/console/room-store";

/**
 * A thread keeps up live when its room moves to another session (after a
 * branch, or once the server moved a stranded thread on): the reader that is
 * open on the old session, which will never carry the reply, is dropped and
 * the room is read again, so nobody has to refresh to see the answer.
 */

afterEach(() => vi.unstubAllGlobals());

/** A stream response for `session` that stays open until the request is aborted, like the real one between events. */
function openStream(session: string, signal: AbortSignal | undefined, aborted: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener("abort", () => {
        aborted.push(session);
        controller.error(new DOMException("aborted", "AbortError"));
      });
    },
  });
  return new Response(body, { headers: { "x-bot-session": session } });
}

describe("following a room", () => {
  it("drops the old session's stream when a message lands in a new session", async () => {
    let current = "s1";
    const streams: string[] = [];
    const aborted: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/stream")) {
          streams.push(current);
          return openStream(current, init?.signal ?? undefined, aborted);
        }
        if (url.endsWith("/messages")) {
          // The server put this message into a new session (a branch, or a stranded thread moved on).
          current = "s2";
          return new Response(JSON.stringify({ room: "desk", sessionId: "s2" }), { headers: { "content-type": "application/json" } });
        }
        return new Response("{}");
      }),
    );
    const store = new RoomStore("desk");
    const stop = store.subscribe(() => undefined);
    await vi.waitFor(() => expect(streams).toEqual(["s1"]));

    expect(await store.send("nothing")).toBe(true);
    // The open reader on s1 is dropped and the room read again, now on s2.
    await vi.waitFor(() => expect(streams).toEqual(["s1", "s2"]));
    expect(aborted).toContain("s1");
    stop();
  });

  it("keeps the open stream when the message lands in the session being read", async () => {
    const streams: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/stream")) {
          streams.push("s1");
          return openStream("s1", init?.signal ?? undefined, []);
        }
        return new Response(JSON.stringify({ room: "desk", sessionId: "s1" }), { headers: { "content-type": "application/json" } });
      }),
    );
    const store = new RoomStore("desk");
    const stop = store.subscribe(() => undefined);
    await vi.waitFor(() => expect(streams).toEqual(["s1"]));
    await store.send("yo");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(streams).toEqual(["s1"]);
    stop();
  });
});
