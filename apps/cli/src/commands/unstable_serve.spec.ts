// @test-scope ./unstable_serve.ts
import { EventEmitter } from "node:events";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { operationalServeLifetime } from "./unstable_serve.js";

describe("operational serve lifetime", () => {
  it("closes a host acquired after SIGTERM during workflow loading", async () => {
    const signals = new EventEmitter();
    const close = vi.fn(async () => undefined);
    const listen = vi.fn(async () => "http://127.0.0.1:4111");
    let resolveStart:
      | ((host: { listen: typeof listen; close: typeof close }) => void)
      | undefined;
    const delayedStart = new Promise<{
      listen: typeof listen;
      close: typeof close;
    }>((resolve) => {
      resolveStart = resolve;
    });
    const logs: string[] = [];
    const running = Effect.runPromise(
      operationalServeLifetime(
        () => delayedStart,
        (message) => logs.push(message),
        signals,
      ),
    );

    await vi.waitFor(() => expect(signals.listenerCount("SIGTERM")).toBe(1));
    signals.emit("SIGTERM");
    resolveStart?.({ listen, close });

    await expect(running).resolves.toBeUndefined();
    expect(listen).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(logs).toEqual([]);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("closes an active host and removes signal listeners", async () => {
    const signals = new EventEmitter();
    const close = vi.fn(async () => undefined);
    const listen = vi.fn(async () => "http://127.0.0.1:4111");
    const running = Effect.runPromise(
      operationalServeLifetime(
        async () => ({ listen, close }),
        () => undefined,
        signals,
      ),
    );
    await vi.waitFor(() => expect(signals.listenerCount("SIGINT")).toBe(1));

    signals.emit("SIGINT");
    await expect(running).resolves.toBeUndefined();

    expect(close).toHaveBeenCalledOnce();
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("closes a host acquired after interruption during startup", async () => {
    const signals = new EventEmitter();
    const controller = new AbortController();
    const close = vi.fn(async () => undefined);
    const listen = vi.fn(async () => "http://127.0.0.1:4111");
    let resolveStart:
      | ((host: { listen: typeof listen; close: typeof close }) => void)
      | undefined;
    const delayedStart = new Promise<{
      listen: typeof listen;
      close: typeof close;
    }>((resolve) => {
      resolveStart = resolve;
    });
    const running = Effect.runPromise(
      operationalServeLifetime(
        () => delayedStart,
        () => undefined,
        signals,
      ),
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(signals.listenerCount("SIGTERM")).toBe(1));

    controller.abort(new Error("interrupted"));
    resolveStart?.({ listen, close });

    await expect(running).rejects.toBeInstanceOf(Error);
    expect(listen).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });
});
