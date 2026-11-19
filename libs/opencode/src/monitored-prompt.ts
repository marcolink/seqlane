import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect";
import { InteractionRequiredError } from "@seqlane/core";
import type { OpenCodeTransport } from "./transport.js";
import { openCodeEffect } from "./effect-boundary.js";
import { OpenCodeExecutorError } from "./errors.js";
import type { OpenCodeUncertainActivity } from "./protocol.js";

const runAbortTimeoutMs = 2_000;

export type MonitoredPromptResult<T> =
  | { readonly type: "response"; readonly response: T }
  | { readonly type: "transport-error"; readonly cause: unknown }
  | { readonly type: "cancelled" }
  | { readonly type: "interaction" }
  | { readonly type: "monitor-error"; readonly cause: unknown };

export interface MonitoredPromptOptions<T, R> {
  readonly transport: Pick<OpenCodeTransport, "monitorSession">;
  readonly sessionID: string;
  readonly runSignal: AbortSignal;
  readonly requestSignal?: AbortSignal;
  readonly prompt: (signal: AbortSignal) => Promise<T>;
  readonly handleResponse: (response: T) => Promise<R>;
  readonly observeEvents: (
    events: AsyncIterable<unknown>,
    signal: AbortSignal,
    onStarted: () => void,
  ) => Effect.Effect<boolean, unknown>;
  readonly beforePrompt: () => Promise<void>;
  readonly abortSession: (originalFailure?: unknown) => Promise<void>;
  readonly onUncertainActivity:
    ((activity: OpenCodeUncertainActivity) => void) | undefined;
}

/** Owns one prompt's SDK edges, native fibers and confirmed cleanup. */
export function runMonitoredPrompt<T, R>(
  options: MonitoredPromptOptions<T, R>,
): Effect.Effect<MonitoredPromptResult<R>, unknown> {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const monitorController = new AbortController();
      const promptController = new AbortController();
      const monitorSignal = AbortSignal.any([
        monitorController.signal,
        options.runSignal,
      ]);
      const promptSignal = AbortSignal.any([
        promptController.signal,
        options.runSignal,
      ]);
      const scope = yield* Scope.make("sequential");
      const monitorStarted = yield* Deferred.make<void>();
      let promptOperation: Promise<void> | undefined;
      let monitorFiber: Fiber.Fiber<MonitorResult> | undefined;
      const requestSignal = AbortSignal.any([
        options.runSignal,
        ...(options.requestSignal === undefined ? [] : [options.requestSignal]),
      ]);
      const cancelled = yield* Effect.forkIn(
        Effect.callback<void>((resume) => {
          const onAbort = (): void => {
            promptController.abort();
            monitorController.abort();
            resume(Effect.void);
          };
          if (requestSignal.aborted) onAbort();
          else requestSignal.addEventListener("abort", onAbort, { once: true });
          return Effect.sync(() =>
            requestSignal.removeEventListener("abort", onAbort),
          );
        }).pipe(
          Effect.andThen(openCodeEffect(() => options.abortSession())),
          Effect.tapError(() =>
            Effect.sync(() =>
              options.onUncertainActivity?.({ reason: "timeout" }),
            ),
          ),
          Effect.as({ type: "cancelled" } as const),
        ),
        scope,
        { uninterruptible: false },
      );
      const operation = Effect.gen(function* () {
        const events = yield* Effect.tryPromise({
          try: (effectSignal) =>
            options.transport.monitorSession(
              options.sessionID,
              AbortSignal.any([monitorSignal, effectSignal]),
            ),
          catch: (cause) =>
            new OpenCodeExecutorError(
              "could not monitor external interaction requirements",
              cause,
            ),
        });
        monitorFiber = yield* Effect.forkIn(
          options
            .observeEvents(events, monitorSignal, () => {
              Deferred.doneUnsafe(monitorStarted, Effect.void);
            })
            .pipe(
              Effect.map((interaction) =>
                interaction
                  ? ({ type: "interaction" } as const)
                  : ({ type: "stopped" } as const),
              ),
              Effect.catchCause((cause) =>
                Effect.succeed({
                  type: "monitor-error" as const,
                  cause: Cause.squash(cause),
                }),
              ),
            ),
          scope,
        );
        yield* Effect.raceFirst(
          Deferred.await(monitorStarted),
          Fiber.join(cancelled),
        );
        if (requestSignal?.aborted) return yield* Fiber.join(cancelled);
        yield* openCodeEffect(() => options.beforePrompt());
        if (requestSignal?.aborted || options.runSignal.aborted)
          return yield* Fiber.join(cancelled);
        const promptFiber = yield* Effect.forkIn(
          openCodeEffect((effectSignal) => {
            const operation = options.prompt(
              AbortSignal.any([promptSignal, effectSignal]),
            );
            // Retain the actual SDK settlement, independently of fiber interruption.
            promptOperation = operation.then(
              () => undefined,
              () => undefined,
            );
            return operation.then(
              (response) => ({ type: "response" as const, response }),
              (cause: unknown) => ({
                type: "transport-error" as const,
                cause,
              }),
            );
          }),
          scope,
        );
        const result = yield* Effect.raceAllFirst([
          Fiber.join(promptFiber),
          Fiber.join(monitorFiber).pipe(
            Effect.flatMap((result) =>
              result.type === "stopped" ? Effect.never : Effect.succeed(result),
            ),
          ),
          Fiber.join(cancelled),
        ]);
        if (requestSignal?.aborted) return yield* Fiber.join(cancelled);
        if (result.type === "response")
          return {
            type: "response" as const,
            response: yield* openCodeEffect(() =>
              options.handleResponse(result.response),
            ),
          };
        if (result.type === "interaction") {
          promptController.abort();
          yield* openCodeEffect(() =>
            options.abortSession(new InteractionRequiredError("user-input")),
          );
          if (promptOperation === undefined)
            return yield* Effect.fail(
              new OpenCodeExecutorError(
                "OpenCode prompt did not start before interaction was required",
              ),
            );
          const pending = promptOperation;
          yield* boundedWait(
            openCodeEffect(() => pending),
            "OpenCode prompt did not settle after external session termination",
            1_000,
          ).pipe(
            Effect.catch((cause) =>
              Effect.sync(() =>
                options.onUncertainActivity?.({
                  reason: "timeout",
                  termination: pending,
                }),
              ).pipe(
                Effect.andThen(
                  Effect.fail(
                    new OpenCodeExecutorError(
                      "OpenCode prompt termination was not confirmed",
                      cause,
                    ),
                  ),
                ),
              ),
            ),
          );
        } else if (result.type === "monitor-error") {
          promptController.abort();
          yield* openCodeEffect(() => options.abortSession(result.cause));
        }
        return result;
      });
      const outcome = yield* Effect.exit(restore(operation));
      monitorController.abort();
      yield* Fiber.interrupt(cancelled);
      const cleanupFailures: unknown[] = [];
      const callbackFailures: unknown[] = [];
      const reportUncertain = (termination: Promise<unknown>): void => {
        void termination.catch(() => undefined);
        try {
          options.onUncertainActivity?.({ reason: "timeout", termination });
        } catch (cause) {
          callbackFailures.push(cause);
        }
      };
      if (
        Exit.isFailure(outcome) &&
        Cause.hasInterrupts(outcome.cause) &&
        promptOperation !== undefined
      ) {
        promptController.abort();
        const aborted = yield* Effect.exit(
          openCodeEffect(() => options.abortSession()),
        );
        if (Exit.isFailure(aborted))
          cleanupFailures.push(Cause.squash(aborted.cause));
      }
      if (monitorFiber !== undefined) {
        const fiber = monitorFiber;
        const stopped = yield* Effect.exit(
          boundedWait(
            Fiber.join(fiber),
            "external interaction monitor termination was not confirmed",
          ),
        );
        if (Exit.isFailure(stopped)) {
          cleanupFailures.push(Cause.squash(stopped.cause));
          reportUncertain(Effect.runPromise(Fiber.join(fiber)));
        } else if (stopped.value.type === "monitor-error") {
          cleanupFailures.push(
            new OpenCodeExecutorError(
              "could not monitor external interaction requirements",
              stopped.value.cause,
            ),
          );
        }
      }
      // Closing can wait for an SDK iterator that ignores interruption. Keep its
      // native fiber alive for the existing bounded quarantine/termination edge.
      const closing = yield* Effect.forkDetach(Scope.close(scope, Exit.void));
      const closed = yield* Effect.exit(
        boundedWait(
          Fiber.join(closing),
          "external interaction monitor termination was not confirmed",
        ),
      );
      if (Exit.isFailure(closed)) {
        cleanupFailures.push(Cause.squash(closed.cause));
        reportUncertain(Effect.runPromise(Fiber.join(closing)));
      }
      const failures =
        callbackFailures.length > 0
          ? [...callbackFailures, ...cleanupFailures]
          : Exit.isSuccess(outcome) && outcome.value.type === "monitor-error"
            ? []
            : cleanupFailures;
      if (failures.length > 0) {
        const cause =
          failures.length === 1 ? failures[0] : new AggregateError(failures);
        return yield* Effect.fail(
          Exit.isFailure(outcome)
            ? new OpenCodeExecutorError(
                "external interaction monitor cleanup failed",
                new AggregateError([Cause.squash(outcome.cause), cause]),
              )
            : cause,
        );
      }
      return yield* outcome;
    }),
  );
}

type MonitorResult =
  | { readonly type: "interaction" }
  | { readonly type: "stopped" }
  | { readonly type: "monitor-error"; readonly cause: unknown };

function boundedWait<A>(
  operation: Effect.Effect<A, unknown>,
  message: string,
  timeoutMs = runAbortTimeoutMs,
) {
  return Effect.interruptible(operation).pipe(
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () => Effect.fail(new OpenCodeExecutorError(message)),
    }),
  );
}
