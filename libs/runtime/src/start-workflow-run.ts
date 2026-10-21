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
import type { PrivateClassifierConnection } from "./classifier/types.js";
import type { InvocationObservationEvent } from "@seqlane/protocol";
import {
  publishRunOutcome,
  settleRunProgram,
} from "./runtime/execution/settle-run-program.js";
import type {
  EffectPlanRunContext,
  EffectPlanRunResult,
} from "./runtime/execution/effect-plan.js";
import type { Effect } from "effect";

export interface StartWorkflowRunRequest<Input = unknown, Output = unknown> {
  readonly workflow: BuiltWorkflow<Input, Output>;
  readonly input: JsonValue;
  /** Pre-bootstrapped adapter runtime supplied by application composition. */
  readonly agentRuntime?: AgentRuntime;
  /** Workspace for direct execution. */
  readonly workspace?: string;
  readonly standalone?: StandaloneRunOptions;
  /** Private run-scoped classifier endpoint and credential. */
  readonly classifierConnection?: PrivateClassifierConnection;
  readonly onObservation?: (
    event: Omit<InvocationObservationEvent, "metadata">,
  ) => void;
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

function classifierConnectionOptions(
  connection: PrivateClassifierConnection | undefined,
): { readonly classifierConnection?: PrivateClassifierConnection } {
  return connection === undefined ? {} : { classifierConnection: connection };
}

async function resolveDirectExecution<Input, Output>(
  request: StartWorkflowRunRequest<Input, Output>,
  signal: AbortSignal,
  runId: RunId,
  classifierOptions: ReturnType<typeof classifierConnectionOptions>,
): Promise<RuntimeExecution> {
  const notifier: RuntimeSessionUiNotifier | undefined =
    request.onRuntimeSessionUi;
  if (request.standalone !== undefined) {
    if (request.agentRuntime !== undefined)
      throw new TypeError(
        "Select standalone execution or a direct agent runtime, not both",
      );
    return createStandaloneExecution(
      {
        ...request.standalone,
        ...classifierOptions,
      },
      request.workflow.taskDefinitions,
      signal,
      runId,
      notifier,
    );
  }

  const agentRuntime = request.agentRuntime;
  return resolveRuntimeProfile(
    {
      id: agentRuntime === undefined ? "local" : "direct",
      ...(request.workspace === undefined
        ? {}
        : { workspace: request.workspace }),
    },
    request.workflow.taskDefinitions,
    signal,
    request.input,
    notifier,
    {
      runId,
      ...(agentRuntime === undefined
        ? {}
        : { agentRuntime: async () => agentRuntime }),
      ...classifierOptions,
    },
  );
}

interface PrivateStartWorkflowComposition {
  readonly program: (
    context: EffectPlanRunContext,
  ) => Effect.Effect<EffectPlanRunResult>;
}

/** Runs a trusted built workflow through the private runtime composition. */
export function startWorkflowRun<Input, Output>(
  request: StartWorkflowRunRequest<Input, Output>,
  composition?: PrivateStartWorkflowComposition,
): WorkflowRunHandle {
  const effectProgram = composition?.program;
  const { workId, runId } = identityFor(request);
  const abortController = new AbortController();
  let activeRun: MastraActiveRun | undefined;
  let cancellationRequested = request.signal?.aborted ?? false;
  let cancellation: Promise<void> | undefined;
  let resolveOutcomeSettlement!: (outcome: SeqlaneRunOutcome) => void;
  const outcomeSettlement = new Promise<SeqlaneRunOutcome>((resolve) => {
    resolveOutcomeSettlement = resolve;
  });
  const cancel = (): Promise<void> => {
    if (cancellationRequested)
      return (
        cancellation ??
        (effectProgram === undefined
          ? Promise.resolve()
          : outcomeSettlement.then(() => undefined))
      );
    cancellationRequested = true;
    abortController.abort();
    cancellation =
      activeRun?.cancel() ??
      (effectProgram === undefined
        ? Promise.resolve()
        : outcomeSettlement.then(() => undefined));
    return cancellation;
  };
  const onAbort = (): void => void cancel().catch(() => undefined);
  if (request.signal?.aborted) abortController.abort(request.signal.reason);
  else request.signal?.addEventListener("abort", onAbort, { once: true });
  const classifierOptions = classifierConnectionOptions(
    request.classifierConnection,
  );

  const outcome = (async (): Promise<SeqlaneRunOutcome> => {
    let execution: RuntimeExecution | undefined;
    let requestRuntimeAdopted = false;
    let mastraExecution: MastraPlanExecution | undefined;
    let result: SeqlaneRunOutcome;
    try {
      request.events.emit({ type: "run.started", workId, runId });
      abortController.signal.throwIfAborted();
      if (effectProgram !== undefined) {
        // Let the caller receive the handle before any task callback can start.
        await Promise.resolve();
        abortController.signal.throwIfAborted();
        const program = effectProgram({
          workflow: request.workflow,
          input: request.input,
          workId,
          runId,
          signal: abortController.signal,
          events: request.events,
          createInvocationId: () => randomUUID(),
          resolveExecution: async (signal) => {
            const resolved = await resolveDirectExecution(
              request,
              signal,
              runId,
              classifierOptions,
            );
            requestRuntimeAdopted = request.agentRuntime !== undefined;
            return resolved;
          },
          onObservation: (event) => request.onObservation?.(event),
          onDiagnostic: request.onDiagnostic,
        });
        const settled = await settleRunProgram(program, abortController.signal);
        result =
          settled.status === "succeeded"
            ? { status: "succeeded", result: settled.output }
            : settled;
      } else {
        const workflowInput = request.workflow.workflow.input.parse(
          request.input,
        );
        execution = await resolveDirectExecution(
          request,
          abortController.signal,
          runId,
          classifierOptions,
        );
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
          onObservation: request.onObservation,
          classifier: execution.classifier,
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
      }
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
      () =>
        execution?.close?.() ??
        (requestRuntimeAdopted ? undefined : request.agentRuntime?.close?.()),
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
      publishRunOutcome(request.events, workId, runId, result);
    } catch (cause) {
      if (result.status === "succeeded")
        return { status: "failed", error: new RuntimeError(cause) };
    }
    return result;
  })();
  void outcome.then(resolveOutcomeSettlement);
  if (cancellationRequested)
    cancellation = outcomeSettlement.then(() => undefined);
  return { workId, runId, outcome, cancel };
}

export type { RuntimeSessionUiAvailable };
