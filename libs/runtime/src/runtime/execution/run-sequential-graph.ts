import { Cause, Deferred, Effect, Exit, Fiber, Semaphore } from "effect";
import type {
  SequentialProgramStep,
  SequentialProgramStepResult,
} from "./program.js";

/** Execute validated dependency-ready steps in scoped fibers. */
export function runSequentialGraph(
  steps: readonly (SequentialProgramStep & {
    readonly dependsOn: readonly string[];
  })[],
  concurrency: number,
  abortSignal: AbortSignal,
  sharedSemaphore?: Semaphore.Semaphore,
): Effect.Effect<readonly SequentialProgramStepResult[]> {
  return Effect.scoped(
    Effect.gen(function* () {
      const deferreds = yield* Effect.forEach(steps, () =>
        Deferred.make<SequentialProgramStepResult>(),
      );
      const completionById = new Map(
        steps.map((step, index) => {
          const completion = deferreds[index];
          if (completion === undefined) {
            throw new Error(
              `No completion signal was created for "${step.id}"`,
            );
          }
          return [step.id, completion] as const;
        }),
      );
      const semaphore =
        sharedSemaphore ??
        (Number.isFinite(concurrency)
          ? yield* Semaphore.make(concurrency)
          : undefined);
      const fibers: Fiber.Fiber<void>[] = [];

      for (const step of steps) {
        const completion = requiredCompletion(completionById, step.id);
        const body = executeStep(step, completionById, semaphore, abortSignal);
        const completeOnExit = Effect.exit(body).pipe(
          Effect.flatMap((exit) =>
            Exit.isSuccess(exit)
              ? Effect.void
              : Deferred.succeed(completion, {
                  status: "failed",
                  error: Cause.squash(exit.cause),
                }).pipe(Effect.asVoid),
          ),
        );
        fibers.push(yield* Effect.forkScoped(completeOnExit));
      }

      yield* Effect.forEach(fibers, (fiber) => Fiber.await(fiber));
      return yield* Effect.forEach(steps, (step) =>
        Deferred.await(requiredCompletion(completionById, step.id)),
      );
    }),
  );
}

function executeStep(
  step: SequentialProgramStep & { readonly dependsOn: readonly string[] },
  completionById: ReadonlyMap<
    string,
    Deferred.Deferred<SequentialProgramStepResult>
  >,
  semaphore: Semaphore.Semaphore | undefined,
  abortSignal: AbortSignal,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const dependencyResults = yield* Effect.forEach(step.dependsOn, (id) =>
      Deferred.await(requiredCompletion(completionById, id)),
    );
    const failedDependencies = step.dependsOn.flatMap((id, index) =>
      dependencyResults[index]?.status === "failed" ? [id] : [],
    );
    const completion = requiredCompletion(completionById, step.id);
    if (abortSignal.aborted) {
      step.onCancel?.();
      yield* Deferred.succeed(completion, {
        status: "failed",
        error: cancellationReason(abortSignal),
      });
      return;
    }
    if (failedDependencies.length > 0) {
      const firstFailure = dependencyResults.find(
        (result) => result.status === "failed",
      );
      step.onSkip?.(failedDependencies);
      yield* Deferred.succeed(completion, {
        status: "failed",
        error:
          firstFailure?.status === "failed"
            ? firstFailure.error
            : new Error(`Step "${step.id}" skipped after dependency failure`),
      });
      return;
    }

    const body = Effect.suspend(() => {
      if (abortSignal.aborted) {
        return Effect.try({
          try: () => step.onCancel?.(),
          catch: (error) => error,
        }).pipe(Effect.andThen(Effect.fail(cancellationReason(abortSignal))));
      }
      if (step.executeEffect !== undefined) {
        const withBodyPermit = <A, E>(effect: Effect.Effect<A, E>) =>
          semaphore === undefined ? effect : semaphore.withPermit(effect);
        return step.executeEffect({ abortSignal, withBodyPermit }).pipe(
          Effect.map((value): SequentialProgramStepResult => ({
            status: "success",
            value,
          })),
          Effect.catch((error) =>
            Effect.succeed({ status: "failed", error } as const),
          ),
        );
      }
      return Effect.tryPromise({
        try: () => step.execute({ abortSignal }),
        catch: (error) => error,
      }).pipe(
        Effect.map((value): SequentialProgramStepResult => ({
          status: "success",
          value,
        })),
        Effect.catch((error) =>
          Effect.succeed({ status: "failed", error } as const),
        ),
      );
    });
    const result =
      step.executeEffect === undefined
        ? semaphore === undefined
          ? yield* body
          : yield* semaphore.withPermit(body)
        : yield* body;
    yield* Deferred.succeed(completion, result);
  });
}

function cancellationReason(signal: AbortSignal): unknown {
  return signal.aborted
    ? signal.reason
    : new Error("Program execution cancelled");
}

function requiredCompletion(
  completions: ReadonlyMap<
    string,
    Deferred.Deferred<SequentialProgramStepResult>
  >,
  stepId: string,
): Deferred.Deferred<SequentialProgramStepResult> {
  const completion = completions.get(stepId);
  if (completion === undefined) {
    throw new Error(`No completion signal exists for "${stepId}"`);
  }
  return completion;
}
