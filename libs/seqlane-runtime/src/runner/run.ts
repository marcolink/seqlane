import { randomUUID } from "node:crypto";
import {
  encodeSeqlaneExecutionEvent,
  type SeqlaneExecutionEvent,
} from "@seqlane/events";
import { RuntimeError, type RunRequest } from "@seqlane/core";
import { EffectCompiler } from "../runtime/compile/compile-plan.js";
import {
  startCompiledWorkflow,
  type ActiveWorkflowRun,
} from "../runtime/execution/workflow-run.js";
import { resolveCompiledWorkflowSessions } from "../runtime/session/session-preflight.js";
import { createExecutionEventBridge } from "./event-bridge.js";
import { loadWorkflow, type LoadedWorkflow } from "./workflow/load-workflow.js";
import { createSeqlanePlanSnapshot } from "./workflow/plan-snapshot.js";
import {
  resolveRuntimeProfile,
  type RuntimeExecution,
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
  activeRun?: ActiveWorkflowRun;
}

export type RuntimeExecutionResolver = (
  profile: RunRequest["runtime"],
  taskDefinitions: LoadedWorkflow["taskDefinitions"],
  signal: AbortSignal,
  input: RunRequest["input"],
  onSessionUiAvailable?: RuntimeSessionUiNotifier,
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

  try {
    // The loaded workflow and Plan remain reachable only from this child.
    const loadedWorkflow = await loadWorkflow(request.workflow, request.input);
    retainWorkflow(loadedWorkflow);

    if (control.cancellationRequested) {
      events.emit({ type: "run.cancelled", workId, runId });
      await events.flush();
      host.exit(0);
      return;
    }

    if (request.dryRun) {
      events.emitPlan(
        createSeqlanePlanSnapshot(loadedWorkflow.plan),
        workId,
        runId,
      );
      events.emit({ type: "run.succeeded", workId, runId, output: null });
      await events.flush();
      host.exit(0);
      return;
    }

    const execution = await resolveExecution(
      request.runtime,
      loadedWorkflow.taskDefinitions,
      abortController.signal,
      request.input,
      (notification) => sendRuntimeSessionUi(host, notification),
    );
    const compiled = new EffectCompiler().compileWorkflow(loadedWorkflow.plan, {
      workId,
      runId,
      createInvocationId,
      workflowInput: request.input,
      executors: execution.executors,
      sessionResolver: execution.sessionResolver,
      workspaceResources: execution.workspaceResources,
      taskDefinitions: execution.taskDefinitions,
      validatorDefinitions: loadedWorkflow.validatorDefinitions,
      events,
    });
    await resolveCompiledWorkflowSessions(compiled);

    events.emitPlan(createSeqlanePlanSnapshot(compiled.plan), workId, runId);

    if (control.cancellationRequested) {
      events.emit({ type: "run.cancelled", workId, runId });
      await events.flush();
      host.exit(0);
      return;
    }

    const activeRun = startCompiledWorkflow(compiled, {
      emitRunStarted: false,
    });
    control.activeRun = activeRun;
    if (control.cancellationRequested) await activeRun.cancel();
    await activeRun.outcome;
    await events.flush();
    control.activeRun = undefined;
    host.exit(0);
  } catch (cause) {
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
