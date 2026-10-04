import { isJsonValue, RuntimeError } from "@seqlane/core";
import type { RunRequest } from "@seqlane/protocol";
import { createExecutionEventBridge } from "@seqlane/runtime";
import type { AgentRuntimeFactory } from "@seqlane/agent-adapter";
import type { ExecutionRenderer, OutputCapabilities } from "@seqlane/tui";
import {
  OperationalClient,
  OperationalClientError,
} from "./operational-client.js";
import { startOwnedOperationalHost } from "./operational-command-host.js";
import type { EventDispatcher } from "./event-dispatcher.js";
import { closeOwnedResources } from "./run-cleanup.js";
import {
  createRunCancellationResult,
  createRunFailureResult,
  createRunSuccessResult,
  executionEventError,
  remoteError,
  type RunIdentity,
} from "./run-result.js";
import { writeSessionUiDiagnostic } from "./session-ui-diagnostic.js";
import type { WorkflowRoots } from "./workflow-discovery.js";
import { randomUUID } from "node:crypto";

export interface RunOperationalHostOptions {
  readonly request: RunRequest;
  readonly sourceWorkflowReference?: string;
  readonly roots: WorkflowRoots;
  readonly serverUrl?: string;
  readonly hostname: string;
  readonly port: number;
  readonly storageUrl: string;
  readonly agentRuntime?: AgentRuntimeFactory;
  readonly jsonMode: boolean;
  readonly renderer?: ExecutionRenderer;
  readonly capabilities: OutputCapabilities;
  readonly dispatcher: EventDispatcher;
}

export interface RunOperationalHostResult {
  readonly commandResult: import("./cli-contracts.js").RunCommandResult;
  readonly exitStatus: 0 | 1 | 130;
  readonly cleanupErrors: readonly unknown[];
}

async function cancelOperationalRun(
  client: OperationalClient,
  runId: string,
  workflowId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await client.cancelRun(runId, workflowId);
      return;
    } catch (error) {
      if (!(error instanceof OperationalClientError) || error.status !== 404) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new OperationalClientError(
    `Operational run "${runId}" did not become cancellable before the retry limit`,
  );
}

export async function executeOperationalHostRun(
  options: RunOperationalHostOptions,
): Promise<RunOperationalHostResult> {
  const {
    request,
    sourceWorkflowReference,
    roots,
    serverUrl,
    hostname,
    port,
    storageUrl,
    agentRuntime,
    jsonMode,
    renderer,
    capabilities,
    dispatcher,
  } = options;
  const workflow = {
    id: request.workflow.id,
    reference: sourceWorkflowReference ?? request.workflow.id,
  };
  const identity: RunIdentity = {
    workId: randomUUID(),
    runId: randomUUID(),
    startedAt: new Date().toISOString(),
  };
  const events = createExecutionEventBridge(async (event) => {
    dispatcher.consume(event);
  });
  let client: OperationalClient | undefined;
  let ownedHost:
    Awaited<ReturnType<typeof startOwnedOperationalHost>> | undefined;
  let cancellationRequested = false;
  let cancellationSignal: "SIGINT" | "SIGTERM" | undefined;
  let cancellationPromise: Promise<void> | undefined;
  let cancellationError: unknown;
  const observationController = new AbortController();
  const requestCancellation = (signal?: "SIGINT" | "SIGTERM"): void => {
    cancellationRequested = true;
    cancellationSignal ??= signal;
    if (client === undefined || cancellationPromise !== undefined) return;
    cancellationPromise = cancelOperationalRun(
      client,
      identity.runId,
      request.workflow.id,
    );
    void cancellationPromise.catch((error: unknown) => {
      cancellationError = error;
      observationController.abort(error);
    });
  };
  let exitStatus: 0 | 1 | 130 = 1;
  let commandResult: import("./cli-contracts.js").RunCommandResult | undefined;
  let cleanupErrors: readonly unknown[] = [];
  const recoveryErrors: unknown[] = [];
  const onSigint = (): void => requestCancellation("SIGINT");
  const onSigterm = (): void => requestCancellation("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    ownedHost =
      serverUrl === undefined
        ? await startOwnedOperationalHost({
            roots,
            workflow: request.workflow,
            host: hostname,
            port,
            storageUrl,
            agentRuntime,
            eventSink: () => events,
            onSessionUiAvailable: (notification) => {
              // Out-of-band writes move the cursor underneath Ink's live tree.
              if (renderer?.mode === "human") return;
              if (renderer?.handleRuntimeSessionUi !== undefined) {
                renderer.handleRuntimeSessionUi(notification);
                return;
              }
              if (jsonMode) return;
              writeSessionUiDiagnostic(capabilities, notification.browserUrl);
            },
          })
        : undefined;
    client = new OperationalClient(serverUrl ?? ownedHost?.address ?? "");
    if (cancellationRequested) requestCancellation();
    events.emit({
      type: "run.started",
      workId: identity.workId,
      runId: identity.runId,
    });
    const result = await client.startRun({
      workflowId: request.workflow.id,
      runId: identity.runId,
      workId: identity.workId,
      input: request.input,
      runtimeId: request.runtime.id,
      workspace: request.runtime.workspace,
      signal: observationController.signal,
    });
    await cancellationPromise;
    if (cancellationError !== undefined) throw cancellationError;
    if (
      cancellationRequested ||
      result.status === "canceled" ||
      result.status === "cancelled"
    ) {
      events.emit({
        type: "run.cancelled",
        workId: identity.workId,
        runId: identity.runId,
      });
      exitStatus = 130;
      commandResult = createRunCancellationResult(
        workflow,
        identity,
        cancellationRequested ? "signal" : "runtime_cancelled",
        cancellationRequested
          ? `Run cancelled after ${cancellationSignal ?? "signal"}`
          : "Run cancelled by the runtime",
      );
    } else if (result.status === "success" && isJsonValue(result.result)) {
      events.emit({
        type: "run.succeeded",
        workId: identity.workId,
        runId: identity.runId,
        output: result.result,
      });
      exitStatus = 0;
      commandResult = createRunSuccessResult(workflow, identity, result.result);
    } else if (result.status === "success") {
      const serializationFailure = new TypeError(
        "Workflow result is not JSON serializable",
      );
      events.emit({
        type: "run.failed",
        workId: identity.workId,
        runId: identity.runId,
        error: new RuntimeError(serializationFailure),
      });
      commandResult = createRunFailureResult(
        serializationFailure,
        "result-serialization",
        workflow,
        identity,
      );
    } else {
      const executionCause =
        result.error === undefined
          ? new Error(`Operational run ended with status "${result.status}"`)
          : remoteError(result.error);
      events.emit({
        type: "run.failed",
        workId: identity.workId,
        runId: identity.runId,
        error: executionEventError(executionCause),
      });
      commandResult = createRunFailureResult(
        executionCause,
        "execution",
        workflow,
        identity,
      );
    }
    await events.flush();
  } catch (error) {
    const deliveryFailure = await events.settle();
    let failure = deliveryFailure ?? error;
    if (cancellationPromise !== undefined) {
      try {
        await cancellationPromise;
      } catch (cancellationFailure) {
        failure = deliveryFailure ?? cancellationFailure;
      }
    }
    if (cancellationError !== undefined)
      failure = deliveryFailure ?? cancellationError;
    let terminal: Parameters<typeof events.sendTerminal>[0];
    if (
      deliveryFailure === undefined &&
      (cancellationRequested || observationController.signal.aborted)
    ) {
      terminal = {
        type: "run.cancelled",
        workId: identity.workId,
        runId: identity.runId,
      };
      exitStatus = 130;
      commandResult = createRunCancellationResult(
        workflow,
        identity,
        "signal",
        `Run cancelled after ${cancellationSignal ?? "signal"}`,
      );
    } else {
      terminal = {
        type: "run.failed",
        workId: identity.workId,
        runId: identity.runId,
        error: executionEventError(failure),
      };
      exitStatus = 1;
      commandResult = createRunFailureResult(
        failure,
        "execution",
        workflow,
        identity,
      );
    }
    try {
      await events.sendTerminal(terminal);
    } catch (terminalFailure) {
      recoveryErrors.push(terminalFailure);
      exitStatus = 1;
      if (commandResult.status === "cancelled") {
        commandResult = createRunFailureResult(
          terminalFailure,
          "execution",
          workflow,
          identity,
        );
      }
    }
  } finally {
    cleanupErrors = [
      ...recoveryErrors,
      ...(await closeOwnedResources([
        () => {
          process.removeListener("SIGINT", onSigint);
          process.removeListener("SIGTERM", onSigterm);
        },
        () => ownedHost?.close(),
        () => events.flush(),
        () => dispatcher?.flush(),
        () => dispatcher?.close(),
        () => renderer?.finish(),
      ])),
    ];
  }
  if (commandResult === undefined) {
    throw new Error("Operational run ended without a result");
  }
  return { commandResult, exitStatus, cleanupErrors };
}
