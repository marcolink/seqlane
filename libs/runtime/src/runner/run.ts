import { randomUUID } from "node:crypto";
import {
  encodeSeqlaneExecutionEvent,
  type SeqlaneExecutionEvent,
} from "@seqlane/protocol";
import { RuntimeError } from "@seqlane/core";
import type { RunRequest } from "@seqlane/protocol";
import type { MastraActiveRun } from "../runtime/mastra/mastra-runtime.js";
import {
  createMastraPlanExecution,
  emitMastraInvocationTopology,
} from "../runtime/mastra/mastra-execution.js";
import { preflightCompiledWorkflowModels } from "../runtime/execution/model-preflight.js";
import {
  preflightCompiledWorkflowSessionCapabilities,
  resolveCompiledWorkflowSessions,
} from "../runtime/session/session-preflight.js";
import { createExecutionEventBridge } from "./event-bridge.js";
import { loadWorkflow, type LoadedWorkflow } from "./workflow/load-workflow.js";
import { createSeqlanePlanSnapshot } from "./workflow/plan-snapshot.js";
import {
  resolveRuntimeProfile,
  type RuntimeExecution,
  type RuntimeProfileResolutionOptions,
  type RuntimeSessionUiNotifier,
} from "./profile/runtime-profile.js";
import {
  encodeRuntimeSessionUiAvailable,
  type RuntimeSessionUiAvailable,
} from "./runtime-session-ui.js";

export interface RunnerHost {
  on(event: "message", listener: (message: unknown) => void): this;
  send(message: string, callback?: (error?: Error) => void): boolean;
  exit(code?: number): never;
}

export interface RunnerRunControl {
  cancellationRequested: boolean;
  abortController?: AbortController;
  activeRun?: MastraActiveRun;
}

export type RuntimeExecutionResolver = (
  profile: RunRequest["runtime"],
  taskDefinitions: LoadedWorkflow["taskDefinitions"],
  signal: AbortSignal,
  input: RunRequest["input"],
  onSessionUiAvailable?: RuntimeSessionUiNotifier,
  options?: RuntimeProfileResolutionOptions,
) => RuntimeExecution | Promise<RuntimeExecution>;

export function requestRunnerCancellation(control: RunnerRunControl): void {
  if (control.cancellationRequested) return;
  control.cancellationRequested = true;
  control.abortController?.abort();
  void control.activeRun?.cancel();
}

function sendEvent(
  host: RunnerHost,
  event: SeqlaneExecutionEvent,
): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const encoded = encodeSeqlaneExecutionEvent(event);
      host.send(encoded, (error) => {
        if (error) reject(error);
        else resolve();
      });
    } catch (cause) {
      reject(cause);
    }
  });
}

function sendRuntimeSessionUi(
  host: RunnerHost,
  notification: RuntimeSessionUiAvailable,
): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const encoded = encodeRuntimeSessionUiAvailable(notification);
      host.send(encoded, (error) => {
        if (error) reject(error);
        else resolve();
      });
    } catch (cause) {
      reject(cause);
    }
  });
}

export async function startRun(
  host: RunnerHost,
  request: RunRequest,
  createWorkId: () => string,
  createRunId: () => string,
  retainWorkflow: (workflow: LoadedWorkflow) => void,
  control: RunnerRunControl,
  resolveExecution: RuntimeExecutionResolver = resolveRuntimeProfile,
  createInvocationId: (_nodeId?: string) => string = () => randomUUID(),
): Promise<void> {
  const abortController = new AbortController();
  control.abortController = abortController;
  const workId = createWorkId();
  const runId = createRunId();
  const events = createExecutionEventBridge((event) => sendEvent(host, event));

  events.emit({ type: "run.started", workId, runId });
  let execution: RuntimeExecution | undefined;

  try {
    // The loaded workflow and Plan remain reachable only from this child.
    const loadedWorkflow = await loadWorkflow(request.workflow);
    retainWorkflow(loadedWorkflow);

    // The authored Plan is available before an executor adapter can resolve.
    // Publish it first so human output can show planned work during setup.
    events.emitPlan(
      createSeqlanePlanSnapshot(loadedWorkflow.plan),
      workId,
      runId,
    );

    if (control.cancellationRequested) {
      events.emit({ type: "run.cancelled", workId, runId });
      await events.flush();
      host.exit(0);
      return;
    }

    if (request.dryRun) {
      events.emit({ type: "run.succeeded", workId, runId, output: null });
      await events.flush();
      host.exit(0);
      return;
    }

    execution = await resolveExecution(
      request.runtime,
      loadedWorkflow.taskDefinitions,
      abortController.signal,
      request.input,
      (notification) => sendRuntimeSessionUi(host, notification),
      { runId },
      // The classifier connection is process-private startup state, never part
      // of the public runner command.
    );
    const mastraExecution = createMastraPlanExecution({
      plan: loadedWorkflow.plan,
      workId,
      runId,
      workflowInput: request.input,
      executors: execution.executors,
      sessionResolver: execution.sessionResolver,
      workspaceResources: execution.workspaceResources,
      taskDefinitions: execution.taskDefinitions,
      validatorDefinitions: loadedWorkflow.validatorDefinitions,
      workflowDefinitions: loadedWorkflow.workflowDefinitions,
      workflow: loadedWorkflow.workflow,
      events,
      onObservation: (event) => events.emitObservation(event),
      classifier: execution.classifier,
      createInvocationId,
    });
    // Topology is already compiled and does not depend on model/session
    // preflight. Emit it now so the interactive TUI is useful while a slow
    // executor setup is still in progress.
    emitMastraInvocationTopology(
      mastraExecution.compiled,
      mastraExecution.prepared,
      events,
    );
    preflightCompiledWorkflowSessionCapabilities(mastraExecution.prepared);
    await preflightCompiledWorkflowModels(mastraExecution.prepared);
    await resolveCompiledWorkflowSessions(mastraExecution.prepared);

    if (control.cancellationRequested) {
      await execution.close?.();
      execution = undefined;
      events.emit({ type: "run.cancelled", workId, runId });
      await events.flush();
      host.exit(0);
      return;
    }

    const activeRun = mastraExecution.runtime.start({
      workflowKey: mastraExecution.compiled.key,
      input: request.input,
      workId,
      runId,
    });
    control.activeRun = activeRun;
    if (control.cancellationRequested) await activeRun.cancel();
    const outcome = await activeRun.outcome;
    await execution.close?.();
    execution = undefined;
    if (outcome.status === "succeeded") {
      events.emit({
        type: "run.succeeded",
        workId,
        runId,
        output: outcome.result,
      });
    } else if (outcome.status === "cancelled") {
      events.emit({ type: "run.cancelled", workId, runId });
    } else {
      events.emit({ type: "run.failed", workId, runId, error: outcome.error });
    }
    await events.flush();
    control.activeRun = undefined;
    host.exit(0);
  } catch (cause) {
    await execution?.close?.().catch(() => undefined);
    if (control.cancellationRequested && control.activeRun === undefined) {
      events.emit({ type: "run.cancelled", workId, runId });
      await events.flush();
      host.exit(0);
      return;
    }
    events.emit({
      type: "run.failed",
      workId,
      runId,
      error: new RuntimeError(cause),
    });
    await events.flush();
    host.exit(0);
  }
}
