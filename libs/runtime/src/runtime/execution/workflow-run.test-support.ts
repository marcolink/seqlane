// @test-scope ./effect-plan.ts
// @test-scope ./settle-run-program.ts

import { RuntimeError, type SeqlaneRunOutcome } from "@seqlane/core";
import type { CompiledPlan } from "../compile/compile-plan.js";
import { runCompiledGraphProgram } from "./effect-plan.js";
import { publishRunOutcome, settleRunProgram } from "./settle-run-program.js";

export interface ActiveWorkflowRun {
  readonly outcome: Promise<SeqlaneRunOutcome>;
  cancel(): Promise<void>;
}

export interface StartCompiledWorkflowOptions {
  readonly emitRunStarted?: boolean;
  readonly heartbeatIntervalMs?: number;
  readonly signal?: AbortSignal;
}

/** Test facade over the native graph interpreter; no Promise graph scheduler. */
export function startCompiledWorkflow(
  compiled: CompiledPlan,
  options: StartCompiledWorkflowOptions = {},
): ActiveWorkflowRun {
  const { context } = compiled;
  const controller = new AbortController();
  let cancelPromise: Promise<void> | undefined;
  const cancel = (): Promise<void> => {
    controller.abort();
    cancelPromise ??= outcome.then(() => undefined);
    return cancelPromise;
  };
  const onAbort = (): void => {
    void cancel().catch(() => undefined);
  };
  if (options.signal?.aborted) controller.abort(options.signal.reason);
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  const outcome = (async (): Promise<SeqlaneRunOutcome> => {
    if (options.emitRunStarted ?? true) {
      context.events.emit({
        type: "run.started",
        workId: context.workId,
        runId: context.runId,
      });
    }
    try {
      const result = await settleRunProgram(
        runCompiledGraphProgram(
          compiled,
          compiled.plan.workflow.id,
          controller.signal,
          undefined,
          options.heartbeatIntervalMs,
        ),
        controller.signal,
      );
      publishRunOutcome(context.events, context.workId, context.runId, result);
      if (result.status === "succeeded") {
        return { status: "succeeded", result: result.output };
      }
      return result;
    } catch (cause) {
      const error = new RuntimeError(cause);
      publishRunOutcome(context.events, context.workId, context.runId, {
        status: "failed",
        error,
      });
      return { status: "failed", error };
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
    }
  })();
  return { outcome, cancel };
}

export async function runCompiledWorkflow(
  compiled: CompiledPlan,
): Promise<SeqlaneRunOutcome> {
  return startCompiledWorkflow(compiled).outcome;
}
