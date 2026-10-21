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
import type { InvocationObservationEvent } from "@seqlane/protocol";
import type { RuntimeExecution } from "../../runner/profile/runtime-profile.js";
import { PlanCompiler } from "../compile/compile-plan.js";
import { findUnconfirmedInvocationTermination } from "./executor.js";
import { emitInvocationTopology } from "./workflow-run.js";
import { toSeqlaneInvocationError } from "./errors.js";
import { runProgram, type SequentialProgramStepResult } from "./program.js";
import { preflightCompiledWorkflowModels } from "./model-preflight.js";
import {
  preflightCompiledWorkflowSessionCapabilities,
  resolveCompiledWorkflowSessions,
} from "../session/session-preflight.js";

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
  readonly resolveExecution: (signal: AbortSignal) => Promise<RuntimeExecution>;
  readonly onObservation?: (
    event: Omit<InvocationObservationEvent, "metadata">,
  ) => void;
  readonly onDiagnostic?: (message: string) => void;
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

    let closeFailure: { readonly cause: unknown } | undefined;
    const programExit = yield* Effect.exit(
      Effect.acquireUseRelease(
        Effect.tryPromise({
          try: () => context.resolveExecution(context.signal),
          catch: (cause) => cause,
        }),
        (execution) =>
          runCompiledPlan(context, parsedWorkflowInput.success, execution),
        (execution) =>
          Effect.tryPromise({
            try: () => Promise.resolve(execution.close?.()),
            catch: (cause) => cause,
          }).pipe(
            Effect.catch((cause) =>
              Effect.sync(() => {
                closeFailure = { cause };
              }),
            ),
          ),
      ),
    );
    let result = Exit.isSuccess(programExit)
      ? programExit.value
      : resolveAcquisitionFailure(
          Cause.squash(programExit.cause),
          context.workflow.workflow.id,
          context.signal,
        );
    if (closeFailure !== undefined) {
      const closeError = new RuntimeError(closeFailure.cause);
      if (result.status === "succeeded") result = failed(closeError);
      else {
        try {
          context.onDiagnostic?.(closeError.message);
        } catch {
          /* Preserve the primary run result. */
        }
      }
    }
    return result;
  });
}

function runCompiledPlan(
  context: EffectPlanRunContext,
  workflowInput: unknown,
  execution: RuntimeExecution,
): Effect.Effect<EffectPlanRunResult, unknown> {
  return Effect.gen(function* () {
    // The resolver is an owned async edge and may settle after cancellation.
    // Close the acquired profile, but never preflight or start its work.
    if (context.signal.aborted) return { status: "cancelled" } as const;

    let compiled: ReturnType<PlanCompiler["compileWorkflow"]>;
    try {
      compiled = new PlanCompiler().compileWorkflow(context.workflow.plan, {
        workId: context.workId,
        runId: context.runId,
        workflowInput,
        createInvocationId: context.createInvocationId,
        executors: execution.executors,
        sessionResolver: execution.sessionResolver,
        workspaceResources: execution.workspaceResources,
        taskDefinitions: execution.taskDefinitions,
        validatorDefinitions: context.workflow.validatorDefinitions,
        workflowDefinitions: context.workflow.workflowDefinitions,
        events: context.events,
        onObservation: (invocationId, observation, iteration) =>
          context.onObservation?.({
            type: "invocation.observation",
            workId: context.workId,
            runId: context.runId,
            invocationId,
            ...observation,
            ...(iteration === undefined ? {} : { iteration }),
          }),
        classifier: execution.classifier,
        concurrency: MAX_CONCURRENT_PLAN_BODIES,
      });
    } catch (cause) {
      return failed(new RuntimeError(cause));
    }

    try {
      preflightCompiledWorkflowSessionCapabilities(compiled);
      yield* Effect.tryPromise({
        try: () => preflightCompiledWorkflowModels(compiled),
        catch: (cause) => cause,
      });
      yield* Effect.tryPromise({
        try: () => resolveCompiledWorkflowSessions(compiled),
        catch: (cause) => cause,
      });
    } catch (cause) {
      if (
        context.signal.aborted &&
        findUnconfirmedInvocationTermination(cause) === undefined
      )
        return { status: "cancelled" } as const;
      return failed(
        toSeqlaneInvocationError(
          cause,
          "runtime",
          context.workflow.workflow.id,
        ),
      );
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

function resolveAcquisitionFailure(
  cause: unknown,
  workflowId: string,
  signal: AbortSignal,
): EffectPlanRunResult {
  const uncertainTermination = findUnconfirmedInvocationTermination(cause);
  if (signal.aborted && uncertainTermination === undefined)
    return { status: "cancelled" };
  return failed(
    toSeqlaneInvocationError(
      uncertainTermination ?? cause,
      "runtime",
      workflowId,
    ),
  );
}

/** Resolve graph failure before cancellation so uncertain termination wins. */
export function resolveGraphFailure(
  workflowId: string,
  signal: AbortSignal,
  results: readonly SequentialProgramStepResult[],
): EffectPlanRunResult | undefined {
  const failedStep = results.find((result) => result.status === "failed");
  const uncertainTermination = results
    .map((result) =>
      result.status === "failed"
        ? findUnconfirmedInvocationTermination(result.error)
        : undefined,
    )
    .find((error) => error !== undefined);
  if (signal.aborted) {
    if (uncertainTermination !== undefined) {
      return failed(
        toSeqlaneInvocationError(uncertainTermination, "runtime", workflowId),
      );
    }
    return { status: "cancelled" };
  }
  if (uncertainTermination !== undefined)
    return failed(
      toSeqlaneInvocationError(uncertainTermination, "runtime", workflowId),
    );
  return failedStep === undefined
    ? undefined
    : failed(toSeqlaneInvocationError(failedStep.error, "runtime", workflowId));
}

function failed(error: SeqlaneError): EffectPlanRunResult {
  return { status: "failed", error };
}
