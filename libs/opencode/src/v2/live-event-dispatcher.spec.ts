// @test-scope ./client.ts
// @test-scope ./tracked-event-body.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "./client.js";
import { createLiveEventDispatcher } from "./live-event-dispatcher.js";

function fixture() {
  let active = 0;
  let maximum = 0;
  const connections: {
    emit: (value: unknown) => void;
    end: () => void;
    cancelled: ReturnType<typeof vi.fn>;
  }[] = [];
  let release: () => void = () => undefined;
  let gate: Promise<void> | undefined;
  const fetch = vi.fn(async () => {
    active++;
    maximum = Math.max(maximum, active);
    const closing = gate;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const cancelled = vi.fn(async () => {
      await closing;
      active--;
    });
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
      cancel: cancelled,
    });
    connections.push({
      cancelled,
      emit(value) {
        controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`),
        );
      },
      end() {
        active--;
        controller.close();
      },
    });
    return new Response(body, {
      headers: { "content-type": "text/event-stream" },
    });
  });
  vi.stubGlobal("fetch", fetch);
  return {
    fetch,
    connections,
    dispatcher: createLiveEventDispatcher(createClient("http://fixture")),
    holdClose() {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    releaseClose() {
      release();
    },
    get active() {
      return active;
    },
    get maximum() {
      return maximum;
    },
  };
}
const event = (sessionID: string, id = "event") => ({
  id,
  type: "session.tool.called",
  data: { sessionID },
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("runtime-owned live event dispatcher", () => {
  it("starts lazily, routes owned hints, and keeps peers alive after unsubscribe", async () => {
    const h = fixture();
    const left = vi.fn();
    const right = vi.fn();
    expect(h.fetch).not.toHaveBeenCalled();
    const unsubscribeLeft = h.dispatcher.subscribe((id) => id === "left", left);
    const unsubscribeRight = h.dispatcher.subscribe(
      (id) => id === "right",
      right,
    );
    try {
      await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1));
      h.connections[0]!.emit(event("left"));
      h.connections[0]!.emit(event("foreign", "foreign"));
      h.connections[0]!.emit({
        id: "malformed",
        type: "session.idle",
        data: { sessionID: 42 },
      });
      await vi.waitFor(() =>
        expect(left).toHaveBeenCalledExactlyOnceWith("messages"),
      );
      expect(right).not.toHaveBeenCalled();
      await unsubscribeLeft();
      expect(h.active).toBe(1);
      h.connections[0]!.emit({
        id: "child",
        type: "session.created",
        data: { sessionID: "child", parentID: "right" },
      });
      await vi.waitFor(() =>
        expect(right).toHaveBeenCalledExactlyOnceWith("full"),
      );
      await unsubscribeRight();
      expect(h.active).toBe(0);
      expect(h.connections[0]!.cancelled).toHaveBeenCalledTimes(1);
      expect(h.maximum).toBe(1);
    } finally {
      await h.dispatcher.close();
    }
  });

  it("joins the last reader before starting a subscriber that arrives during shutdown", async () => {
    const h = fixture();
    h.holdClose();
    const unsubscribe = h.dispatcher.subscribe(
      () => true,
      () => undefined,
    );
    let stopped = false;
    try {
      await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1));
      const stopping = unsubscribe().then(() => {
        stopped = true;
      });
      await vi.waitFor(() =>
        expect(h.connections[0]!.cancelled).toHaveBeenCalledTimes(1),
      );
      const notify = vi.fn();
      h.dispatcher.subscribe((id) => id === "peer", notify);
      expect(stopped).toBe(false);
      expect(h.fetch).toHaveBeenCalledTimes(1);
      h.releaseClose();
      await stopping;
      await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(2));
      h.connections[1]!.emit(event("peer"));
      await vi.waitFor(() => expect(notify).toHaveBeenCalledWith("messages"));
      expect(h.maximum).toBe(1);
    } finally {
      h.releaseClose();
      await h.dispatcher.close();
    }
    expect(h.active).toBe(0);
  });

  it("joins native cancellation during runtime close and rejects new subscriptions", async () => {
    const h = fixture();
    h.holdClose();
    h.dispatcher.subscribe(
      () => true,
      () => undefined,
    );
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1));
    let closed = false;
    const closing = h.dispatcher.close().then(() => {
      closed = true;
    });
    await vi.waitFor(() =>
      expect(h.connections[0]!.cancelled).toHaveBeenCalledTimes(1),
    );
    expect(closed).toBe(false);
    expect(() =>
      h.dispatcher.subscribe(
        () => true,
        () => undefined,
      ),
    ).toThrow("event dispatcher is closed");
    h.releaseClose();
    await closing;
    expect(h.active).toBe(0);
    await h.dispatcher.close();
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("reconnects without overlapping native readers", async () => {
    const h = fixture();
    const notify = vi.fn();
    h.dispatcher.subscribe(() => true, notify);
    try {
      await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1));
      h.connections[0]!.end();
      await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(2), {
        timeout: 800,
      });
      h.connections[1]!.emit(event("owned"));
      await vi.waitFor(() => expect(notify).toHaveBeenCalledWith("messages"));
      expect(h.maximum).toBe(1);
    } finally {
      await h.dispatcher.close();
    }
    expect(h.active).toBe(0);
  });

  it("joins a rotated reader before opening its replacement", async () => {
    vi.useFakeTimers();
    const h = fixture();
    h.holdClose();
    h.dispatcher.subscribe(
      () => true,
      () => undefined,
    );
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(h.fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(45_000);
      expect(h.connections[0]!.cancelled).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.fetch).toHaveBeenCalledTimes(1);
      h.releaseClose();
      await vi.advanceTimersByTimeAsync(300);
      expect(h.fetch).toHaveBeenCalledTimes(2);
      expect(h.maximum).toBe(1);
    } finally {
      h.releaseClose();
      await h.dispatcher.close();
    }
    expect(h.active).toBe(0);
  });
});
