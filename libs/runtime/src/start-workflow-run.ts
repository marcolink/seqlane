import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  createStandaloneExecution,
  type StandaloneRunOptions,
} from "./runner/profile/standalone-profile.js";
import type { MastraPlanExecution } from "./runtime/mastra/mastra-execution.js";
import type {
  BuiltWorkflow,
  JsonValue,
  SeqlaneEventSink,
  SeqlaneRunOutcome,
  WorkId,
  RunId,
} from "@seqlane/core";
import { RuntimeError } from "@seqlane/core";
import type { AgentRuntime } from "@seqlane/agent-adapter";
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
  /** Pre-bootstrapped adapter runtime supplied by application composition. */
  readonly agentRuntime?: AgentRuntime;
  /** Workspace for direct execution. */
  readonly workspace?: string;
  readonly standalone?: StandaloneRunOptions;
  readonly onDiagnostic?: (message: string) => void;
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
    let mastraExecution: MastraPlanExecution | undefined;
    let result: SeqlaneRunOutcome;
    try {
      request.events.emit({ type: "run.started", workId, runId });
      abortController.signal.throwIfAborted();
      const workflowInput = request.workflow.workflow.input.parse(
        request.input,
      );
      const notifier: RuntimeSessionUiNotifier | undefined =
        request.onRuntimeSessionUi;
      if (request.standalone !== undefined) {
        if (request.agentRuntime !== undefined)
          throw new TypeError(
            "Select standalone execution or a direct agent runtime, not both",
          );
        execution = await createStandaloneExecution(
          request.standalone,
          request.workflow.taskDefinitions,
          abortController.signal,
          runId,
          notifier,
        );
      } else {
        const agentRuntime = request.agentRuntime;
        execution = await resolveRuntimeProfile(
          {
            id: agentRuntime === undefined ? "local" : "direct",
            ...(request.workspace === undefined
              ? {}
              : { workspace: request.workspace }),
          },
          request.workflow.taskDefinitions,
          abortController.signal,
          request.input,
          notifier,
          {
            runId,
            ...(agentRuntime === undefined
              ? {}
              : { agentRuntime: async () => agentRuntime }),
          },
        );
      }
      abortController.signal.throwIfAborted();
      mastraExecution = createMastraPlanExecution({
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
        // Input has been validated and transformed once above.
        workflow: {
          input: z.unknown(),
          output: request.workflow.workflow.output,
        },
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
      abortController.signal.throwIfAborted();
      activeRun = mastraExecution.runtime.start({
        workflowKey: mastraExecution.compiled.key,
        input: workflowInput,
        workId,
        runId,
      });
      if (cancellationRequested) await activeRun.cancel();
      result = await activeRun.outcome;
    } catch (cause) {
      result = cancellationRequested
        ? { status: "cancelled" }
        : { status: "failed", error: new RuntimeError(cause) };
    }
    const cleanupFailures: unknown[] = [];
    for (const close of [
      // A direct runtime is bootstrapped by application composition before
      // input validation. If validation fails, the resolver never takes
      // ownership, so release that run-scoped resource here.
      () => execution?.close?.() ?? request.agentRuntime?.close?.(),
      () => mastraExecution?.runtime.shutdown(),
    ]) {
      try {
        await close();
      } catch (cause) {
        cleanupFailures.push(cause);
      }
    }
    request.signal?.removeEventListener("abort", onAbort);
    if (cleanupFailures.length > 0) {
      const error = new RuntimeError(
        new AggregateError(cleanupFailures, "Workflow cleanup failed"),
      );
      if (result.status === "succeeded") result = { status: "failed", error };
      else {
        try {
          request.onDiagnostic?.(error.message);
        } catch {
          /* Preserve the primary outcome. */
        }
      }
    }
    try {
      if (result.status === "succeeded")
        request.events.emit({
          type: "run.succeeded",
          workId,
          runId,
          output: result.result,
        });
      else if (result.status === "cancelled")
        request.events.emit({ type: "run.cancelled", workId, runId });
      else
        request.events.emit({
          type: "run.failed",
          workId,
          runId,
          error: result.error,
        });
    } catch (cause) {
      if (result.status === "succeeded")
        return { status: "failed", error: new RuntimeError(cause) };
    }
    return result;
  })();
  return { workId, runId, outcome, cancel };
}

export type { RuntimeSessionUiAvailable };
