import { Effect, Exit, Fiber, Scope } from "effect";
import { InteractionRequiredError } from "@seqlane/core";
import type { OpenCodeTransport } from "./transport.js";
import { awaitOwnedCleanup } from "./owned-cleanup.js";
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
  readonly transport: OpenCodeTransport;
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

/** Owns one prompt's event stream, fibers, cancellation race, and monitor cleanup. */
export async function runMonitoredPrompt<T, R>(
  options: MonitoredPromptOptions<T, R>,
): Promise<MonitoredPromptResult<R>> {
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
  let removeRequestListener = (): void => undefined;
  const requestSignal = options.requestSignal;
  const cancellation = requestSignal
    ? new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          requestSignal.removeEventListener("abort", onAbort);
          promptController.abort();
          monitorController.abort();
          void options.abortSession().then(resolve, (cause: unknown) => {
            options.onUncertainActivity?.({ reason: "timeout" });
            reject(cause);
          });
        };
        removeRequestListener = () =>
          requestSignal.removeEventListener("abort", onAbort);
        if (requestSignal.aborted) onAbort();
        else
          requestSignal.addEventListener("abort", onAbort, {
            once: true,
          });
      })
    : undefined;
  const monitorScope = Effect.runSync(Scope.make("sequential"));
  let monitorFiber:
    | Fiber.Fiber<
        | { readonly type: "interaction" }
        | { readonly type: "stopped" }
        | { readonly type: "monitor-error"; readonly cause: unknown },
        never
      >
    | undefined;
  let promptOperation: Promise<void> | undefined;
  let failed = false;
  let originalFailure: unknown;
  let monitorFailure = false;
  let operationResult: MonitoredPromptResult<R> | undefined;

  try {
    const events = await Effect.runPromise(
      Effect.provideService(
        Effect.acquireRelease(
          Effect.tryPromise({
            try: (effectSignal) =>
              options.transport.monitorSession(
                options.sessionID,
                AbortSignal.any([monitorSignal, effectSignal]),
              ),
            catch: (cause) => cause,
          }),
          () =>
            Effect.promise(async () => {
              monitorController.abort();
              removeRequestListener();
            }),
        ),
        Scope.Scope,
        monitorScope,
      ),
    ).catch((cause: unknown) => {
      throw new OpenCodeExecutorError(
        "could not monitor external interaction requirements",
        cause,
      );
    });

    let reportStarted!: () => void;
    const monitorStarted = new Promise<void>((resolve) => {
      reportStarted = resolve;
    });
    const interaction = options
      .observeEvents(events, monitorSignal, reportStarted)
      .pipe(
        Effect.map((interactionFound) =>
          interactionFound
            ? ({ type: "interaction" } as const)
            : ({ type: "stopped" } as const),
        ),
        Effect.catch((cause) =>
          Effect.succeed({ type: "monitor-error" as const, cause }),
        ),
      );
    const monitorEffectFiber = await Effect.runPromise(
      Effect.provideService(
        Effect.forkIn(interaction, monitorScope),
        Scope.Scope,
        monitorScope,
      ),
    );
    monitorFiber = monitorEffectFiber;
    await monitorStarted;
    await options.beforePrompt();

    const promptResponse = Effect.tryPromise({
      try: (effectSignal) => {
        const operation = options.prompt(
          AbortSignal.any([promptSignal, effectSignal]),
        );
        promptOperation = operation.then(
          () => undefined,
          () => undefined,
        );
        return operation.then(
          (response) => ({ type: "response" as const, response }),
          (cause: unknown) => ({ type: "transport-error" as const, cause }),
        );
      },
      catch: (cause) => cause,
    });
    const promptFiber = await Effect.runPromise(
      Effect.provideService(
        Effect.forkIn(promptResponse, monitorScope),
        Scope.Scope,
        monitorScope,
      ),
    );
    const cancellationResult =
      cancellation === undefined
        ? Effect.never
        : Effect.tryPromise({
            try: () => cancellation,
            catch: (cause) => cause,
          }).pipe(Effect.map(() => ({ type: "cancelled" as const })));
    const result = await Effect.runPromise(
      Effect.provideService(
        Effect.raceFirst(
          Fiber.join(promptFiber),
          Effect.raceFirst(
            Fiber.join(monitorEffectFiber).pipe(
              Effect.flatMap((monitorResult) =>
                monitorResult.type === "stopped"
                  ? Effect.never
                  : Effect.succeed(monitorResult),
              ),
            ),
            cancellationResult,
          ),
        ),
        Scope.Scope,
        monitorScope,
      ),
    );

    if (requestSignal?.aborted && cancellation !== undefined) {
      await cancellation;
      operationResult = { type: "cancelled" };
    } else if (result.type === "response") {
      operationResult = {
        type: "response",
        response: await options.handleResponse(result.response),
      };
    } else {
      if (result.type === "interaction") {
        promptController.abort();
        await options.abortSession(new InteractionRequiredError("user-input"));
        if (promptOperation === undefined) {
          throw new OpenCodeExecutorError(
            "OpenCode prompt did not start before interaction was required",
          );
        }
        try {
          await awaitOwnedCleanup(
            promptOperation,
            "OpenCode prompt did not settle after external session termination",
            1_000,
          );
        } catch (cause) {
          options.onUncertainActivity?.({
            reason: "timeout",
            termination: promptOperation,
          });
          throw new OpenCodeExecutorError(
            "OpenCode prompt termination was not confirmed",
            cause,
          );
        }
      } else if (result.type === "monitor-error") {
        monitorFailure = true;
        promptController.abort();
        await options.abortSession(result.cause);
      }
      operationResult = result;
    }
  } catch (cause) {
    failed = true;
    originalFailure = cause;
  }

  monitorController.abort();
  removeRequestListener();
  let cleanupCause: unknown;
  let uncertaintyCallbackCause: unknown;
  const reportUncertainActivity = (
    activity: OpenCodeUncertainActivity,
  ): void => {
    try {
      options.onUncertainActivity?.(activity);
    } catch (cause) {
      uncertaintyCallbackCause =
        uncertaintyCallbackCause === undefined
          ? cause
          : new AggregateError([uncertaintyCallbackCause, cause]);
    }
  };
  if (monitorFiber !== undefined) {
    const monitorWait = Effect.runPromise(Fiber.join(monitorFiber));
    try {
      const monitorResult = await awaitOwnedCleanup(
        monitorWait,
        "external interaction monitor termination was not confirmed",
        runAbortTimeoutMs,
      );
      if (monitorResult.type === "monitor-error") {
        cleanupCause = new OpenCodeExecutorError(
          "could not monitor external interaction requirements",
          monitorResult.cause,
        );
      }
    } catch (cause) {
      cleanupCause = cause;
      reportUncertainActivity({
        reason: "timeout",
        termination: monitorWait,
      });
    }
  }
  const monitorTermination = Effect.runPromise(
    Scope.close(monitorScope, Exit.void),
  );
  try {
    await awaitOwnedCleanup(
      monitorTermination,
      "external interaction monitor termination was not confirmed",
      runAbortTimeoutMs,
    );
  } catch (cause) {
    reportUncertainActivity({
      reason: "timeout",
      termination: monitorTermination,
    });
    cleanupCause =
      cleanupCause === undefined
        ? cause
        : new AggregateError([cleanupCause, cause]);
  }
  if (uncertaintyCallbackCause !== undefined) {
    const cause =
      cleanupCause === undefined
        ? uncertaintyCallbackCause
        : new AggregateError([uncertaintyCallbackCause, cleanupCause]);
    if (failed) {
      throw new OpenCodeExecutorError(
        "external interaction monitor cleanup failed",
        new AggregateError([originalFailure, cause]),
      );
    }
    throw cause;
  }
  if (cleanupCause !== undefined && !monitorFailure) {
    if (failed) {
      throw new OpenCodeExecutorError(
        "external interaction monitor cleanup failed",
        new AggregateError([originalFailure, cleanupCause]),
      );
    }
    throw cleanupCause;
  }
  if (failed) throw originalFailure;
  if (operationResult === undefined) {
    throw new OpenCodeExecutorError("OpenCode prompt produced no result");
  }
  return operationResult;
}
