import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  runMonitoredPrompt,
  type MonitoredPromptOptions,
} from "./monitored-prompt.js";

function promptOptions(
  controller: AbortController,
): MonitoredPromptOptions<string, string> {
  return {
    sessionID: "session-1",
    runSignal: new AbortController().signal,
    requestSignal: controller.signal,
    transport: {
      monitorSession: async () => ({
        async *[Symbol.asyncIterator]() {
          yield undefined;
        },
      }),
    },
    prompt: async () => "response",
    handleResponse: async (response) => response,
    beforePrompt: async () => undefined,
    abortSession: async () => undefined,
    onUncertainActivity: undefined,
    observeEvents: (_events, signal, onStarted) =>
      Effect.callback<boolean>((resume) => {
        const abort = () => resume(Effect.succeed(false));
        signal.addEventListener("abort", abort, { once: true });
        onStarted();
        return Effect.sync(() => signal.removeEventListener("abort", abort));
      }),
  };
}

describe("native prompt coordination", () => {
  it("inherits the caller span in the monitor fiber", async () => {
    const options = promptOptions(new AbortController());
    let monitorSpan: string | undefined;
    const result = await Effect.runPromise(
      runMonitoredPrompt({
        ...options,
        observeEvents: (...args) =>
          Effect.gen(function* () {
            monitorSpan = (yield* Effect.currentSpan).name;
            return yield* options.observeEvents(...args);
          }),
      }).pipe(Effect.withSpan("caller")),
    );
    expect(result).toEqual({ type: "response", response: "response" });
    expect(monitorSpan).toBe("caller");
  });

  it("does not submit a prompt after cancellation during preparation", async () => {
    const controller = new AbortController();
    const prompt = vi.fn(async () => "response");
    const abortSession = vi.fn(async () => undefined);
    const result = await Effect.runPromise(
      runMonitoredPrompt({
        ...promptOptions(controller),
        prompt,
        abortSession,
        beforePrompt: async () => {
          controller.abort();
        },
      }),
    );
    expect(result).toEqual({ type: "cancelled" });
    expect(prompt).not.toHaveBeenCalled();
    expect(abortSession).toHaveBeenCalledOnce();
  });

  it("waits for external abort confirmation when its parent fiber is interrupted", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const promptStarted = yield* Deferred.make<void>();
        const abortStarted = yield* Deferred.make<void>();
        const confirmAbort = yield* Deferred.make<void>();
        const options = promptOptions(new AbortController());
        const fiber = yield* Effect.forkChild(
          runMonitoredPrompt({
            ...options,
            prompt: () => {
              Deferred.doneUnsafe(promptStarted, Effect.void);
              return new Promise<string>(() => undefined);
            },
            abortSession: () => {
              Deferred.doneUnsafe(abortStarted, Effect.void);
              return Effect.runPromise(Deferred.await(confirmAbort));
            },
          }),
        );
        yield* Deferred.await(promptStarted);
        const interrupt = yield* Effect.forkChild(Fiber.interrupt(fiber));
        yield* Deferred.await(abortStarted);
        expect(fiber.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(confirmAbort, undefined);
        yield* Fiber.join(interrupt);
      }),
    );
  });
});
