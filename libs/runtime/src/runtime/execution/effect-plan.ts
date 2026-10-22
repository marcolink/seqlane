import { Cause, Duration, Effect, Exit, Semaphore } from "effect";
import {
  OutputValidationError,
  RuntimeError,
  type BuiltWorkflow,
  type RunId,
  type SeqlaneError,
  type WorkId,
} from "@seqlane/core";
import { WorkflowInputValidationError } from "./workflow-input-validation-error.js";
import type { InvocationObservationEvent } from "@seqlane/protocol";
import type { RuntimeExecution } from "../../runner/profile/runtime-profile.js";
import { PlanCompiler } from "../compile/compile-plan.js";
import type { ExecutionRunState } from "./context.js";
import type { ExecutionEventSink } from "./context.js";
import type { WorkspaceResourceRegistry } from "../workspace/workspace-resource.js";
import { workspaceResourcesForExecution } from "../workspace/workspace-resources.js";
import { findUnconfirmedInvocationTermination } from "./executor.js";
import { emitInvocationTopology } from "./workflow-run.js";
import { toSeqlaneInvocationError } from "./errors.js";
import { runProgram, type SequentialProgramStepResult } from "./program.js";
import { preflightCompiledWorkflowModels } from "./model-preflight.js";
import {
  preflightCompiledWorkflowSessionCapabilities,
  resolveCompiledWorkflowSessions,
} from "../session/session-preflight.js";
import { executeNestedWorkflow } from "./nested-workflow.js";

export type EffectPlanRunResult =
  | { readonly status: "succeeded"; readonly output: unknown }
  | { readonly status: "failed"; readonly error: SeqlaneError }
  | { readonly status: "cancelled" };

/** Private, engine-neutral input for the target Plan composition. */
export interface EffectPlanRunContext {
  readonly workflow: BuiltWorkflow;
  readonly input: unknown;
  readonly workId: WorkId;
  readonly runId: RunId;
  readonly signal: AbortSignal;
  readonly events: ExecutionEventSink;
  readonly createInvocationId: (nodeId?: string) => string;
  readonly resolveExecution: (signal: AbortSignal) => Promise<RuntimeExecution>;
  readonly onObservation?: (
    event: Omit<InvocationObservationEvent, "metadata">,
  ) => void;
  readonly onDiagnostic?: (message: string) => void;
  readonly runState?: ExecutionRunState;
  readonly workspaceOwnerId?: string;
  readonly workspaceOwnerAncestors?: readonly string[];
  readonly parentInvocationId?: string;
  readonly workspaceResources?: WorkspaceResourceRegistry;
}

const MAX_CONCURRENT_PLAN_BODIES = 8;
const DEFAULT_RUN_HEARTBEAT_INTERVAL_MS = 20_000;

/** Runs one lowered graph with the native interpreter used by Plan runs. */
export function runCompiledGraphProgram(
  compiled: ReturnType<PlanCompiler["compileWorkflow"]>,
  workflowId: string,
  signal: AbortSignal,
  bodySemaphore?: Semaphore.Semaphore,
  heartbeatIntervalMs = DEFAULT_RUN_HEARTBEAT_INTERVAL_MS,
): Effect.Effect<EffectPlanRunResult> {
  return Effect.scoped(
    Effect.gen(function* () {
      const startedAt = Date.now();
      const heartbeatAbortController = new AbortController();
      const graphSignal = AbortSignal.any([
        signal,
        heartbeatAbortController.signal,
      ]);
      if (heartbeatIntervalMs > 0) {
        const heartbeat = Effect.forever(
          Effect.sleep(Duration.millis(heartbeatIntervalMs)).pipe(
            Effect.andThen(
              Effect.sync(() =>
                compiled.context.events.emit({
                  type: "run.heartbeat",
                  workId: compiled.context.workId,
                  runId: compiled.context.runId,
                  activeInvocationIds: compiled.orderedNodes
                    .filter(
                      (node) =>
                        node.type === "task" ||
                        node.type === "workflow" ||
                        node.type === "repeat",
                    )
                    .map(
                      (node) =>
                        compiled.context.invocationIds.get(node.nodeId) ??
                        node.nodeId,
                    ),
                  elapsedMs: Date.now() - startedAt,
                }),
              ),
            ),
          ),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() =>
              heartbeatAbortController.abort(Cause.squash(cause)),
            ).pipe(Effect.andThen(Effect.failCause(cause))),
          ),
        );
        return yield* Effect.raceFirst(
          runCompiledGraphProgramBody(
            compiled,
            workflowId,
            graphSignal,
            bodySemaphore,
          ),
          heartbeat,
        );
      }
      return yield* runCompiledGraphProgramBody(
        compiled,
        workflowId,
        graphSignal,
        bodySemaphore,
      );
    }),
  );
}

function runCompiledGraphProgramBody(
  compiled: ReturnType<PlanCompiler["compileWorkflow"]>,
  workflowId: string,
  signal: AbortSignal,
  bodySemaphore?: Semaphore.Semaphore,
): Effect.Effect<EffectPlanRunResult> {
  return Effect.gen(function* () {
    // Emit deterministic graph topology before any slow SDK/model preflight.
    emitInvocationTopology(compiled.context, compiled.orderedNodes);
    const preflightExit = yield* Effect.exit(
      Effect.gen(function* () {
        preflightCompiledWorkflowSessionCapabilities(compiled);
        yield* Effect.tryPromise({
          try: () => preflightCompiledWorkflowModels(compiled),
          catch: (cause) => cause,
        });
        yield* Effect.tryPromise({
          try: () => resolveCompiledWorkflowSessions(compiled),
          catch: (cause) => cause,
        });
      }),
    );
    if (Exit.isFailure(preflightExit)) {
      const cause = Cause.squash(preflightExit.cause);
      if (
        signal.aborted &&
        findUnconfirmedInvocationTermination(cause) === undefined
      )
        return { status: "cancelled" } as const;
      return failed(toSeqlaneInvocationError(cause, "runtime", workflowId));
    }

    const graphExit = yield* Effect.exit(
      runProgram(compiled.program, signal, bodySemaphore),
    );
    if (Exit.isFailure(graphExit)) {
      return failed(
        toSeqlaneInvocationError(
          Cause.squash(graphExit.cause),
          "runtime",
          workflowId,
        ),
      );
    }
    const graphFailure = resolveGraphFailure(
      workflowId,
      signal,
      graphExit.value,
    );
    if (graphFailure !== undefined) return graphFailure;
    return {
      status: "succeeded",
      output: compiled.context.workflowResult,
    } as const;
  });
}

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
        new WorkflowInputValidationError(
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
  bodySemaphore?: Semaphore.Semaphore,
  runState?: ExecutionRunState,
): Effect.Effect<EffectPlanRunResult, unknown> {
  return Effect.gen(function* () {
    const sharedBodySemaphore =
      bodySemaphore ?? (yield* Semaphore.make(MAX_CONCURRENT_PLAN_BODIES));
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
        workspaceResources:
          context.workspaceResources ??
          workspaceResourcesForExecution(
            execution.workspaceResources,
            context.workflow.workflowDefinitions,
          ),
        workspaceOwnerId: context.workspaceOwnerId,
        workspaceOwnerAncestors: context.workspaceOwnerAncestors,
        parentInvocationId: context.parentInvocationId,
        runState,
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
        onOwnedProcessAcquired: execution.onOwnedProcessAcquired,
        concurrency: MAX_CONCURRENT_PLAN_BODIES,
        executeWorkflow: (
          parentContext,
          node,
          abortSignal,
          _permit,
          deferCompletion,
        ) =>
          executeNestedWorkflow(
            context,
            parentContext,
            node,
            abortSignal,
            execution,
            (childContext, input) =>
              runCompiledPlan(
                childContext,
                input,
                execution,
                sharedBodySemaphore,
                parentContext.runState,
              ),
            deferCompletion,
          ),
      });
    } catch (cause) {
      return failed(new RuntimeError(cause));
    }

    const graphResult = yield* runCompiledGraphProgram(
      compiled,
      context.workflow.workflow.id,
      context.signal,
      sharedBodySemaphore,
      context.parentInvocationId === undefined ? undefined : 0,
    );
    if (graphResult.status !== "succeeded") return graphResult;

    const parsedOutput = yield* Effect.result(
      Effect.try({
        try: () => context.workflow.workflow.output.parse(graphResult.output),
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
