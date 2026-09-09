import { randomUUID } from "node:crypto";
import {
  encodeSeqlaneExecutionEvent,
  type SeqlaneExecutionEvent,
} from "@seqlane/events";
import { RuntimeError, type Plan, type PlanNode, type RunRequest } from "@seqlane/core";
import { createExecutionEventBridge } from "./event-bridge.js";
import { loadWorkflow, type LoadedWorkflow } from "./workflow/load-workflow.js";
import { createSeqlanePlanSnapshot } from "./workflow/plan-snapshot.js";
import {
  resolveRuntimeProfile,
  type RuntimeExecution,
  type RuntimeSessionUiNotifier,
} from "./profile/runtime-profile.js";
import {
  startWorkflowRunInternal,
  type WorkflowRunHandle,
} from "../start-workflow-run.js";
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
  activeRun?: WorkflowRunHandle;
}

export type RuntimeExecutionResolver = (
  profile: RunRequest["runtime"],
  taskDefinitions: LoadedWorkflow["taskDefinitions"],
  signal: AbortSignal,
  input: RunRequest["input"],
  onSessionUiAvailable?: RuntimeSessionUiNotifier,
) => RuntimeExecution | Promise<RuntimeExecution>;

function nodeContainsAgentWork(node: PlanNode): boolean {
  if (node.type === "task") return node.execution !== "local";
  if (node.type === "validation.check") return node.source.type === "task";
  if (node.type === "validation.gate") return false;
  return node.body.nodes.some(nodeContainsAgentWork);
}

export function planContainsAgentWork(plan: Plan): boolean {
  return plan.nodes.some(nodeContainsAgentWork);
}

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

    const activeRun = startWorkflowRunInternal(
      {
        workflow: loadedWorkflow.built,
        input: request.input,
        runtime: request.runtime,
        events,
        signal: abortController.signal,
        identity: { workId, runId },
        onRuntimeSessionUi: (notification) =>
          sendRuntimeSessionUi(host, notification),
      },
      {
        resolveExecution,
        createInvocationId,
        emitRunStarted: false,
        emitPlan: (plan) =>
          events.emitPlan(createSeqlanePlanSnapshot(plan), workId, runId),
      },
    );
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
