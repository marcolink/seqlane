import { Cause, Effect, Metric, Tracer } from "effect";
import { RuntimeError, SeqlaneError } from "@seqlane/core";
import type { TraceCarrier } from "@seqlane/protocol/private/trace-carrier";
import { withRuntimeExecutionSpan } from "../../private/telemetry/run-scope.js";
import type { SeqlaneEventSink, SeqlaneRunOutcome } from "@seqlane/core";
import type { EffectPlanRunResult } from "./effect-plan.js";

/** Evaluate the target run once and wait for its root scope to close. */
export function settleRunProgramEffect(
  program: Effect.Effect<EffectPlanRunResult>,
  signal: AbortSignal,
  traceCarrier?: TraceCarrier,
  nativeServices?: {
    readonly tracer?: Tracer.Tracer;
    readonly metricRegistry?: Map<string, unknown>;
  },
): Effect.Effect<EffectPlanRunResult> {
  let tracedProgram = withRuntimeExecutionSpan(program, traceCarrier);
  if (nativeServices?.tracer !== undefined) {
    tracedProgram = tracedProgram.pipe(
      Effect.provideService(Tracer.Tracer, nativeServices.tracer),
    );
  }
  if (nativeServices?.metricRegistry !== undefined) {
    tracedProgram = tracedProgram.pipe(
      Effect.provideService(
        Metric.MetricRegistry,
        nativeServices.metricRegistry,
      ),
    );
  }
  return Effect.scoped(tracedProgram).pipe(
    Effect.map((result) =>
      signal.aborted && result.status === "succeeded"
        ? { status: "cancelled" as const }
        : result,
    ),
    Effect.catchCause((failure): Effect.Effect<EffectPlanRunResult> => {
      if (signal.aborted && Cause.hasInterruptsOnly(failure))
        return Effect.succeed({ status: "cancelled" as const });
      const cause = Cause.squash(failure);
      return Effect.succeed({
        status: "failed" as const,
        error: cause instanceof SeqlaneError ? cause : new RuntimeError(cause),
      });
    }),
  );
}

/** Promise facade for standalone composition boundaries. */
export function settleRunProgram(
  ...args: Parameters<typeof settleRunProgramEffect>
): Promise<EffectPlanRunResult> {
  return Effect.runPromise(settleRunProgramEffect(...args));
}

/** Publish the canonical run terminal for native program or facade outcomes. */
export function publishRunOutcome(
  events: Pick<SeqlaneEventSink, "emit">,
  workId: string,
  runId: string,
  outcome: EffectPlanRunResult | SeqlaneRunOutcome,
): void {
  if (outcome.status === "succeeded") {
    events.emit({
      type: "run.succeeded",
      workId,
      runId,
      output: "output" in outcome ? outcome.output : outcome.result,
    });
  } else if (outcome.status === "cancelled") {
    events.emit({ type: "run.cancelled", workId, runId });
  } else {
    events.emit({ type: "run.failed", workId, runId, error: outcome.error });
  }
}
