import { RuntimeError, type SeqlaneRunOutcome } from "@seqlane/core";
import type { CompiledPlan } from "../compile/compile-plan.js";
import { runCompiledGraphProgram } from "./effect-plan.js";
import { publishRunOutcome, settleRunProgram } from "./settle-run-program.js";
import { Effect } from "effect";
import { runProgram, type SequentialProgram } from "./program.js";

// @test-scope ./effect-plan.ts
// @test-scope ./settle-run-program.ts

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

export type SequentialProgramResult =
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly error: unknown }
  | { readonly status: "success" };

export function executeSequentialProgram(
  program: SequentialProgram,
  signal?: AbortSignal,
): Promise<SequentialProgramResult> {
  if (signal?.aborted) return Promise.resolve({ status: "cancelled" });
  const abortSignal = signal ?? new AbortController().signal;
  return Effect.runPromise(runProgram(program, abortSignal)).then((results) => {
    if (abortSignal.aborted) return { status: "cancelled" } as const;
    const failed = results.find((result) => result.status === "failed");
    return failed === undefined
      ? ({ status: "success" } as const)
      : ({ status: "failed", error: failed.error } as const);
  });
}
