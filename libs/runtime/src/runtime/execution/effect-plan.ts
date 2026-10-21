import { Cause, Effect, Exit } from "effect";
import {
  InputValidationError,
  OutputValidationError,
  RuntimeError,
  type BuiltWorkflow,
  type JsonValue,
  type RunId,
  type SeqlaneError,
  type SeqlaneEventSink,
  type WorkId,
} from "@seqlane/core";
import { PlanCompiler } from "../compile/compile-plan.js";
import { UnconfirmedInvocationTerminationError } from "./executor.js";
import { emitInvocationTopology } from "./workflow-run.js";
import { toSeqlaneInvocationError } from "./errors.js";
import { runProgram, type SequentialProgramStepResult } from "./program.js";

export type EffectPlanRunResult =
  | { readonly status: "succeeded"; readonly output: unknown }
  | { readonly status: "failed"; readonly error: SeqlaneError }
  | { readonly status: "cancelled" };

/** Private, engine-neutral input for the target Plan composition. */
export interface EffectPlanRunContext {
  readonly workflow: BuiltWorkflow;
  readonly input: JsonValue;
  readonly workId: WorkId;
  readonly runId: RunId;
  readonly signal: AbortSignal;
  readonly events: SeqlaneEventSink;
  readonly createInvocationId: (nodeId?: string) => string;
}

const MAX_CONCURRENT_PLAN_BODIES = 8;

/** Native Effect program shared by the CLI tracer and direct runtime facade. */
export function createEffectPlanProgram(
  context: EffectPlanRunContext,
): Effect.Effect<EffectPlanRunResult> {
  return Effect.gen(function* () {
    const parsedWorkflowInput = yield* Effect.result(
      Effect.try({
        try: () => context.workflow.workflow.input.parse(context.input),
        catch: (cause) => cause,
      }),
    );
    if (parsedWorkflowInput._tag === "Failure") {
      return failed(
        new InputValidationError(
          context.workflow.workflow.id,
          parsedWorkflowInput.failure,
        ),
      );
    }

    let compiled: ReturnType<PlanCompiler["compileWorkflow"]>;
    try {
      compiled = new PlanCompiler().compileWorkflow(context.workflow.plan, {
        workId: context.workId,
        runId: context.runId,
        workflowInput: parsedWorkflowInput.success,
        createInvocationId: context.createInvocationId,
        executors: new Map(),
        taskDefinitions: context.workflow.taskDefinitions,
        validatorDefinitions: context.workflow.validatorDefinitions,
        workflowDefinitions: context.workflow.workflowDefinitions,
        events: context.events,
        concurrency: MAX_CONCURRENT_PLAN_BODIES,
      });
    } catch (cause) {
      return failed(new RuntimeError(cause));
    }

    if (
      compiled.orderedNodes.some(
        (node) =>
          node.type === "repeat" ||
          node.type === "choice" ||
          node.type === "workflow",
      )
    ) {
      return failed(
        new RuntimeError(
          new Error(
            "The S2 Effect Plan runner supports task and validation nodes",
          ),
        ),
      );
    }

    emitInvocationTopology(compiled.context, compiled.orderedNodes);
    const graphExit = yield* Effect.exit(
      runProgram(compiled.program, context.signal),
    );
    if (Exit.isFailure(graphExit)) {
      return failed(
        toSeqlaneInvocationError(
          Cause.squash(graphExit.cause),
          "runtime",
          context.workflow.workflow.id,
        ),
      );
    }
    const graphFailure = resolveGraphFailure(
      context.workflow.workflow.id,
      context.signal,
      graphExit.value,
    );
    if (graphFailure !== undefined) return graphFailure;

    const parsedOutput = yield* Effect.result(
      Effect.try({
        try: () =>
          context.workflow.workflow.output.parse(
            compiled.context.workflowResult,
          ),
        catch: (cause) => cause,
      }),
    );
    if (parsedOutput._tag === "Failure") {
      return failed(
        new OutputValidationError(
          context.workflow.workflow.id,
          parsedOutput.failure,
        ),
      );
    }
    return { status: "succeeded", output: parsedOutput.success } as const;
  });
}

/** Resolve graph failure before cancellation so uncertain termination wins. */
export function resolveGraphFailure(
  workflowId: string,
  signal: AbortSignal,
  results: readonly SequentialProgramStepResult[],
): EffectPlanRunResult | undefined {
  const failedStep = results.find((result) => result.status === "failed");
  if (signal.aborted) {
    const uncertainTermination = results.find(
      (result) =>
        result.status === "failed" &&
        result.error instanceof UnconfirmedInvocationTerminationError,
    );
    if (uncertainTermination?.status === "failed") {
      return failed(
        toSeqlaneInvocationError(
          uncertainTermination.error,
          "runtime",
          workflowId,
        ),
      );
    }
    return { status: "cancelled" };
  }
  return failedStep === undefined
    ? undefined
    : failed(toSeqlaneInvocationError(failedStep.error, "runtime", workflowId));
}

function failed(error: SeqlaneError): EffectPlanRunResult {
  return { status: "failed", error };
}
