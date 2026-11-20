// @test-scope ./client.ts
// @test-scope ./live-event-dispatcher.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "./client.js";
import { createLiveEventDispatcher } from "./live-event-dispatcher.js";
import { monitorWithLiveEvents } from "./live-events.js";

const encoder = new TextEncoder();
function stream() {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const cancel = vi.fn();
  const abort = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    cancel,
  });
  return {
    response: new Response(body, {
      headers: { "content-type": "text/event-stream" },
    }),
    cancel,
    abort,
    connect(signal?: AbortSignal | null) {
      signal?.addEventListener(
        "abort",
        () => {
          abort();
          try {
            controller?.error(signal.reason);
          } catch {
            /* Already closed. */
          }
        },
        { once: true },
      );
      return this.response;
    },
    emit(value: unknown) {
      controller?.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
    },
    close() {
      controller?.close();
    },
  };
}
const native = (sessionID = "owned", id = "evt_live") => ({
  id,
  type: "session.tool.called",
  data: { sessionID },
});
afterEach(() => vi.unstubAllGlobals());

describe("live events as completion wakeups", () => {
  it("shares one stream across concurrent invocation monitors", async () => {
    const connections: ReturnType<typeof stream>[] = [];
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const events = stream();
        connections.push(events);
        return events.connect(init?.signal);
      },
    );
    vi.stubGlobal("fetch", fetch);
    const client = createClient("http://fixture");
    const dispatcher = createLiveEventDispatcher(client);
    const subscribe = vi.spyOn(client.event, "subscribe");
    const controllers = [new AbortController(), new AbortController()];
    const reads = [vi.fn(async () => undefined), vi.fn(async () => undefined)];
    const pending = controllers.map((controller, index) =>
      monitorWithLiveEvents(
        dispatcher,
        (id) => id === `owned_${index}`,
        controller.signal,
        reads[index]!,
      ).catch((cause: unknown) => cause),
    );
    try {
      await vi.waitFor(() => {
        for (const read of reads) expect(read).toHaveBeenCalledTimes(1);
        expect(connections.length).toBeGreaterThanOrEqual(1);
      });
      connections[0]!.emit(native("owned_0"));
      await vi.waitFor(() => expect(reads[0]).toHaveBeenCalledTimes(2), {
        timeout: 400,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(subscribe).toHaveBeenCalledTimes(1);
      expect(reads[1]).toHaveBeenCalledTimes(1);
      controllers[0]!.abort();
      await pending[0];
      expect(connections[0]!.abort).not.toHaveBeenCalled();
      connections[0]!.emit(native("owned_1", "peer-event"));
      await vi.waitFor(() => expect(reads[1]).toHaveBeenCalledTimes(2), {
        timeout: 400,
      });
    } finally {
      for (const controller of controllers) controller.abort();
      await Promise.all(pending);
    }
  });
  it.each([
    { type: "permission.created", data: { sessionID: "owned" } },
    { type: "form.created", data: { form: { sessionID: "owned" } } },
    { type: "form.replied", data: { sessionID: "owned" } },
    {
      type: "session.created",
      data: { sessionID: "child", parentID: "owned" },
    },
  ])(
    "wakes reads for $type with native ownership fields",
    async ({ type, data }) => {
      const events = stream();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
          events.connect(init?.signal),
        ),
      );
      let ready = false;
      const read = vi.fn(async (_signal: AbortSignal, kind?: string) =>
        ready && kind === "full" ? { value: "validated" } : undefined,
      );
      const pending = monitorWithLiveEvents(
        createLiveEventDispatcher(createClient("http://fixture")),
        (id) => id === "owned",
        AbortSignal.timeout(3000),
        read,
      );
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      ready = true;
      events.emit({ id: "native-event", type, data });
      await expect(
        Promise.race([
          pending,
          new Promise((resolve) => setTimeout(() => resolve("missed"), 400)),
        ]),
      ).resolves.toBe("validated");
      expect(read.mock.calls[1]?.[1]).toBe("full");
    },
  );
  it("delivers owned live events before polling, coalesces duplicates, and closes the reader", async () => {
    const events = stream();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
        events.connect(init?.signal),
      ),
    );
    let ready = false;
    const read = vi.fn(async (signal: AbortSignal, kind?: string) => {
      signal.throwIfAborted();
      return ready
        ? {
            value: kind === "full" ? "validated result" : "message-only result",
          }
        : undefined;
    });
    const pending = monitorWithLiveEvents(
      createLiveEventDispatcher(createClient("http://fixture")),
      (id) => id === "owned",
      AbortSignal.timeout(3000),
      read,
    );
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    ready = true;
    for (let index = 0; index < 100; index++) events.emit(native());
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2), {
      timeout: 400,
    });
    expect(read.mock.calls[1]?.[1]).toBe("messages");
    await expect(pending).resolves.toBe("validated result");
    expect(read.mock.calls[2]?.[1]).toBe("full");
    await vi.waitFor(() => expect(events.abort).toHaveBeenCalledTimes(1));
  });

  it("ignores foreign and malformed hints without changing completion", async () => {
    const events = stream();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
        events.connect(init?.signal),
      ),
    );
    const controller = new AbortController();
    const read = vi.fn(async () => undefined);
    const pending = monitorWithLiveEvents(
      createLiveEventDispatcher(createClient("http://fixture")),
      (id) => id === "owned",
      controller.signal,
      read,
    ).catch((cause) => cause);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    events.emit(native("foreign"));
    events.emit({ id: "bad", type: "session.idle", data: { sessionID: 42 } });
    events.emit({
      id: "bad",
      type: "session.idle",
      data: { sessionID: "foreign" },
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(read).toHaveBeenCalledTimes(1);
    controller.abort();
    expect(await pending).toBeInstanceOf(Error);
    await vi.waitFor(() => expect(events.abort).toHaveBeenCalledTimes(1));
  });

  it("rate-limits full reads under sustained distinct native events", async () => {
    const events = stream();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
        events.connect(init?.signal),
      ),
    );
    const times: number[] = [];
    const kinds: (string | undefined)[] = [];
    let eventID = 0;
    const pending = monitorWithLiveEvents(
      createLiveEventDispatcher(createClient("http://fixture")),
      (id) => id === "owned",
      AbortSignal.timeout(5000),
      async (_signal, kind) => {
        times.push(Date.now());
        kinds.push(kind);
        if (times.length === 4) return { value: "bounded" };
        if (times.length > 1)
          for (let index = 0; index < 100; index++)
            events.emit(native("owned", `event_${eventID++}`));
        return undefined;
      },
    );
    await vi.waitFor(() => expect(times).toHaveLength(1));
    events.emit(native("owned", `event_${eventID++}`));
    await expect(pending).resolves.toBe("bounded");
    expect(times[1]! - times[0]!).toBeLessThan(400);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(450);
    expect(times[3]! - times[2]!).toBeGreaterThanOrEqual(450);
    expect(kinds).toEqual(["full", "messages", "messages", "full"]);
    expect(times[3]! - times[0]!).toBeGreaterThanOrEqual(950);
  });

  it("retains a coalesced full hint when later message hints arrive", async () => {
    const events = stream();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
        events.connect(init?.signal),
      ),
    );
    const kinds: string[] = [];
    const pending = monitorWithLiveEvents(
      createLiveEventDispatcher(createClient("http://fixture")),
      (id) => id === "owned",
      AbortSignal.timeout(3000),
      async (_signal, kind) => {
        kinds.push(kind);
        if (kinds.length === 3) return { value: "reconciled" };
        return undefined;
      },
    );
    await vi.waitFor(() => expect(kinds).toHaveLength(1));
    events.emit(native());
    await vi.waitFor(() => expect(kinds).toHaveLength(2));
    events.emit({
      id: "child-created",
      type: "session.created",
      data: { sessionID: "child", parentID: "owned" },
    });
    for (let index = 0; index < 100; index++)
      events.emit(native("owned", `message_${index}`));
    await expect(pending).resolves.toBe("reconciled");
    expect(kinds).toEqual(["full", "messages", "full"]);
  });

  it.each([0, 1100])(
    "bounds recurring full scans under form events after a %d ms initial read",
    async (initialDelay) => {
      const events = stream();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
          events.connect(init?.signal),
        ),
      );
      const times: number[] = [];
      let eventID = 0;
      const pending = monitorWithLiveEvents(
        createLiveEventDispatcher(createClient("http://fixture")),
        (id) => id === "owned",
        AbortSignal.timeout(5000),
        async (_signal, kind) => {
          times.push(Date.now());
          expect(kind).toBe("full");
          if (times.length === 4) return { value: "bounded full scans" };
          for (let index = 0; index < 100; index++)
            events.emit({
              id: `form_${eventID++}`,
              type: "form.replied",
              data: { sessionID: "owned" },
            });
          if (times.length === 1 && initialDelay > 0)
            await new Promise((resolve) => setTimeout(resolve, initialDelay));
          return undefined;
        },
      );
      await expect(pending).resolves.toBe("bounded full scans");
      expect(times[1]! - times[0]!).toBeLessThan(initialDelay + 400);
      expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(950);
      expect(times[3]! - times[2]!).toBeGreaterThanOrEqual(950);
    },
  );

  it("reconnects a closed stream and resumes immediate snapshot reads", async () => {
    const first = stream();
    first.close();
    const second = stream();
    let connections = 0;
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        ++connections === 1
          ? first.connect(init?.signal)
          : second.connect(init?.signal),
    );
    vi.stubGlobal("fetch", fetch);
    let ready = false;
    const pending = monitorWithLiveEvents(
      createLiveEventDispatcher(createClient("http://fixture")),
      (id) => id === "owned",
      AbortSignal.timeout(3000),
      async () => (ready ? { value: "recovered" } : undefined),
    );
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2), {
      timeout: 700,
    });
    ready = true;
    second.emit(native());
    await expect(pending).resolves.toBe("recovered");
    await vi.waitFor(() => expect(second.abort).toHaveBeenCalledTimes(1));
  });

  it("recovers missed events through polling while the live transport fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("connection lost")),
    );
    let reads = 0;
    const result = await monitorWithLiveEvents(
      createLiveEventDispatcher(createClient("http://fixture")),
      (id) => id === "owned",
      AbortSignal.timeout(3000),
      async () => (++reads === 2 ? { value: "polled result" } : undefined),
    );
    expect(result).toBe("polled result");
    expect(reads).toBe(2);
  });

  it("cancels a pending snapshot read and releases the event reader", async () => {
    const events = stream();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
        events.connect(init?.signal),
      ),
    );
    const controller = new AbortController();
    let readSignal: AbortSignal | undefined;
    const pending = monitorWithLiveEvents(
      createLiveEventDispatcher(createClient("http://fixture")),
      (id) => id === "owned",
      controller.signal,
      (signal) =>
        new Promise((_, reject) => {
          readSignal = signal;
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    ).catch((cause) => cause);
    await vi.waitFor(() => expect(readSignal).toBeDefined());
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    controller.abort();
    expect(await pending).toBeInstanceOf(Error);
    expect(readSignal?.aborted).toBe(true);
    await vi.waitFor(() => expect(events.abort).toHaveBeenCalledTimes(1));
  });
});
