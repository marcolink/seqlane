import { randomUUID } from "node:crypto";
import type {
  BuiltWorkflow,
  JsonValue,
  SeqlaneEventSink,
  SeqlaneRunOutcome,
  WorkId,
  RunId,
} from "@seqlane/core";
import type { RuntimeProfileReference } from "@seqlane/protocol";
import { RuntimeError } from "@seqlane/core";
import type { MastraActiveRun } from "./runtime/mastra/mastra-runtime.js";
import {
  createMastraPlanExecution,
  emitMastraInvocationTopology,
} from "./runtime/mastra/mastra-execution.js";
import { preflightCompiledWorkflowModels } from "./runtime/execution/model-preflight.js";
import {
  preflightCompiledWorkflowSessionCapabilities,
  resolveCompiledWorkflowSessions,
} from "./runtime/session/session-preflight.js";
import { resolveRuntimeProfile } from "./runner/profile/runtime-profile.js";
import type { RuntimeSessionUiNotifier } from "./runner/profile/runtime-profile.js";
import type { RuntimeSessionUiAvailable } from "./runner/runtime-session-ui.js";
import type { RuntimeExecution } from "./runner/profile/runtime-profile.js";

export interface StartWorkflowRunRequest<Input = unknown, Output = unknown> {
  readonly workflow: BuiltWorkflow<Input, Output>;
  readonly input: JsonValue;
  readonly runtime: RuntimeProfileReference;
  readonly events: SeqlaneEventSink;
  readonly signal?: AbortSignal;
  readonly identity?: { readonly workId: WorkId; readonly runId: RunId };
  readonly onRuntimeSessionUi?: (
    notification: RuntimeSessionUiAvailable,
  ) => void | Promise<void>;
}

export interface WorkflowRunHandle {
  readonly workId: WorkId;
  readonly runId: RunId;
  readonly outcome: Promise<SeqlaneRunOutcome>;
  cancel(): Promise<void>;
}

function identityFor<Input, Output>(
  request: StartWorkflowRunRequest<Input, Output>,
): { readonly workId: WorkId; readonly runId: RunId } {
  if (request.identity === undefined) {
    return { workId: randomUUID(), runId: randomUUID() };
  }
  if (
    request.identity.workId.length === 0 ||
    request.identity.runId.length === 0
  ) {
    throw new TypeError("Work and Run identities must be non-empty");
  }
  return request.identity;
}

/** Runs a trusted built workflow directly through the private Mastra runtime. */
export function startWorkflowRun<Input, Output>(
  request: StartWorkflowRunRequest<Input, Output>,
): WorkflowRunHandle {
  const { workId, runId } = identityFor(request);
  const abortController = new AbortController();
  let activeRun: MastraActiveRun | undefined;
  let cancellationRequested = false;
  let cancellation: Promise<void> | undefined;
  const cancel = (): Promise<void> => {
    if (cancellationRequested) return cancellation ?? Promise.resolve();
    cancellationRequested = true;
    abortController.abort();
    cancellation = activeRun?.cancel() ?? Promise.resolve();
    return cancellation;
  };
  const onAbort = (): void => void cancel().catch(() => undefined);
  if (request.signal?.aborted) onAbort();
  else request.signal?.addEventListener("abort", onAbort, { once: true });

  const outcome = (async (): Promise<SeqlaneRunOutcome> => {
    let execution: RuntimeExecution | undefined;
    const emitCancelled = (): SeqlaneRunOutcome => {
      request.events.emit({ type: "run.cancelled", workId, runId });
      return { status: "cancelled" };
    };
    try {
      request.events.emit({ type: "run.started", workId, runId });
      if (cancellationRequested) return emitCancelled();
      const workflowInput = request.workflow.workflow.input.parse(
        request.input,
      );
      const notifier: RuntimeSessionUiNotifier | undefined =
        request.onRuntimeSessionUi;
      execution = await resolveRuntimeProfile(
        request.runtime,
        request.workflow.taskDefinitions,
        abortController.signal,
        request.input,
        notifier,
        { environment: process.env, runId },
      );
      if (cancellationRequested) return emitCancelled();
      const mastraExecution = createMastraPlanExecution({
        plan: request.workflow.plan,
        workId,
        runId,
        workflowInput,
        executors: execution.executors,
        sessionResolver: execution.sessionResolver,
        workspaceResources: execution.workspaceResources,
        taskDefinitions: execution.taskDefinitions,
        validatorDefinitions: request.workflow.validatorDefinitions,
        workflowDefinitions: request.workflow.workflowDefinitions,
        workflow: request.workflow.workflow,
        events: request.events,
        createInvocationId: () => randomUUID(),
      });
      preflightCompiledWorkflowSessionCapabilities(mastraExecution.prepared);
      await preflightCompiledWorkflowModels(mastraExecution.prepared);
      await resolveCompiledWorkflowSessions(mastraExecution.prepared);
      emitMastraInvocationTopology(
        mastraExecution.compiled,
        mastraExecution.prepared,
        request.events,
      );
      if (cancellationRequested) return emitCancelled();
      activeRun = mastraExecution.runtime.start({
        workflowKey: mastraExecution.compiled.key,
        input: request.input,
        workId,
        runId,
      });
      if (cancellationRequested) await activeRun.cancel();
      const result = await activeRun.outcome;
      if (result.status === "succeeded") {
        request.events.emit({
          type: "run.succeeded",
          workId,
          runId,
          output: result.result,
        });
      } else if (result.status === "cancelled") {
        request.events.emit({ type: "run.cancelled", workId, runId });
      } else {
        request.events.emit({
          type: "run.failed",
          workId,
          runId,
          error: result.error,
        });
      }
      return result;
    } catch (cause) {
      if (cancellationRequested) return emitCancelled();
      const error = new RuntimeError(cause);
      try {
        request.events.emit({ type: "run.failed", workId, runId, error });
      } catch {
        // Terminal event delivery is best effort. Preserve the original
        // RuntimeError and failed outcome when the sink is unavailable.
      }
      return { status: "failed", error };
    } finally {
      if (execution?.close !== undefined) {
        await execution.close().catch(() => undefined);
      }
      request.signal?.removeEventListener("abort", onAbort);
    }
  })();
  return { workId, runId, outcome, cancel };
}

export type { RuntimeSessionUiAvailable };
