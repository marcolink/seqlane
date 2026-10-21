import { Cause, Effect, Exit } from "effect";
import { RuntimeError } from "@seqlane/core";
import type { SeqlaneEventSink, SeqlaneRunOutcome } from "@seqlane/core";
import type { EffectPlanRunResult } from "./effect-plan.js";

/** Evaluate the target run once and wait for its root scope to close. */
export async function settleRunProgram(
  program: Effect.Effect<EffectPlanRunResult>,
  signal: AbortSignal,
): Promise<EffectPlanRunResult> {
  const exit = await Effect.runPromiseExit(Effect.scoped(program));
  if (Exit.isSuccess(exit)) {
    return signal.aborted && exit.value.status === "succeeded"
      ? { status: "cancelled" }
      : exit.value;
  }

  const cause = Cause.squash(exit.cause);
  if (signal.aborted && Cause.hasInterruptsOnly(exit.cause)) {
    return { status: "cancelled" };
  }
  return { status: "failed", error: new RuntimeError(cause) };
}

/** Publish the canonical run terminal for either target or legacy outcomes. */
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
