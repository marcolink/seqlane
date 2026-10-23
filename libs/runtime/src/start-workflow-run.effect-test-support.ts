import { randomUUID } from "node:crypto";
import type {
  BuiltWorkflow,
  JsonValue,
  RunId,
  SeqlaneEventSink,
  SeqlaneRunOutcome,
  WorkId,
} from "@seqlane/core";
import { RuntimeError } from "@seqlane/core";
import type { AgentRuntime } from "@seqlane/agent-adapter";
import type { InvocationObservationEvent } from "@seqlane/protocol";
import {
  createEffectPlanProgram,
  type EffectPlanRunContext,
} from "./runtime/execution/effect-plan.js";
import type { RuntimeExecution } from "./runner/profile/runtime-profile.js";
import { resolveRuntimeProfile } from "./runner/profile/runtime-profile.js";
import type { RuntimeSessionUiAvailable } from "./runner/runtime-session-ui.js";
import {
  publishRunOutcome,
  settleRunProgram,
} from "./runtime/execution/settle-run-program.js";

interface EffectPlanTestRequest<Input = unknown, Output = unknown> {
  readonly workflow: BuiltWorkflow<Input, Output>;
  readonly input: JsonValue;
  readonly agentRuntime?: AgentRuntime;
  readonly workspace?: string;
  readonly events: SeqlaneEventSink;
  readonly signal?: AbortSignal;
  readonly identity?: { readonly workId: WorkId; readonly runId: RunId };
  readonly onObservation?: (
    event: Omit<InvocationObservationEvent, "metadata">,
  ) => void;
  readonly onDiagnostic?: (message: string) => void;
  readonly onRuntimeSessionUi?: (
    notification: RuntimeSessionUiAvailable,
  ) => void | Promise<void>;
}

export interface EffectPlanTestHandle {
  readonly workId: WorkId;
  readonly runId: RunId;
  readonly outcome: Promise<SeqlaneRunOutcome>;
  cancel(): Promise<void>;
}

type ExecutionResolver = (
  signal: AbortSignal,
  resolveDefault: (signal: AbortSignal) => Promise<RuntimeExecution>,
) => Promise<RuntimeExecution>;

/**
 * Test-only composition for EffectPlan context cases the public facade cannot
 * express. It still executes the production native EffectPlan program.
 */
export function startEffectPlanTestRun<Input, Output>(
  request: EffectPlanTestRequest<Input, Output>,
  resolveExecution?: ExecutionResolver,
): EffectPlanTestHandle {
  const workId = request.identity?.workId ?? randomUUID();
  const runId = request.identity?.runId ?? randomUUID();
  if (workId.length === 0 || runId.length === 0)
    throw new TypeError("Work and Run identities must be non-empty");

  const abortController = new AbortController();
  let cancellationRequested = request.signal?.aborted ?? false;
  let cancellation: Promise<void> | undefined;
  let resolveSettlement!: () => void;
  const settlement = new Promise<void>((resolve) => {
    resolveSettlement = resolve;
  });
  const cancel = (): Promise<void> => {
    if (cancellationRequested) return cancellation ?? settlement;
    cancellationRequested = true;
    abortController.abort(
      request.signal?.aborted ? request.signal.reason : undefined,
    );
    cancellation = settlement;
    return cancellation;
  };
  const onAbort = (): void => void cancel().catch(() => undefined);
  if (request.signal?.aborted) abortController.abort(request.signal.reason);
  else request.signal?.addEventListener("abort", onAbort, { once: true });

  const resolveDefault = async (
    signal: AbortSignal,
  ): Promise<RuntimeExecution> => {
    const agentRuntime = request.agentRuntime;
    return resolveRuntimeProfile(
      {
        id: agentRuntime === undefined ? "local" : "direct",
        ...(request.workspace === undefined && agentRuntime === undefined
          ? {}
          : { workspace: request.workspace ?? process.cwd() }),
      },
      request.workflow.taskDefinitions,
      signal,
      request.input,
      request.onRuntimeSessionUi,
      {
        runId,
        ...(agentRuntime === undefined
          ? {}
          : { agentRuntime: async () => agentRuntime }),
      },
    );
  };

  const context: EffectPlanRunContext = {
    workflow: request.workflow,
    input: request.input,
    workId,
    runId,
    signal: abortController.signal,
    events: request.events,
    createInvocationId: () => randomUUID(),
    resolveExecution: (signal) =>
      resolveExecution === undefined
        ? resolveDefault(signal)
        : resolveExecution(signal, resolveDefault),
    ...(request.onObservation === undefined
      ? {}
      : { onObservation: (event) => request.onObservation?.(event) }),
    ...(request.onDiagnostic === undefined
      ? {}
      : { onDiagnostic: request.onDiagnostic }),
  };

  const outcome = (async (): Promise<SeqlaneRunOutcome> => {
    let result: SeqlaneRunOutcome;
    try {
      request.events.emit({ type: "run.started", workId, runId });
      abortController.signal.throwIfAborted();
      await Promise.resolve();
      abortController.signal.throwIfAborted();
      const settled = await settleRunProgram(
        createEffectPlanProgram(context),
        abortController.signal,
      );
      result =
        settled.status === "succeeded"
          ? { status: "succeeded", result: settled.output }
          : settled;
    } catch (cause) {
      result = cancellationRequested
        ? { status: "cancelled" }
        : { status: "failed", error: new RuntimeError(cause) };
    }
    request.signal?.removeEventListener("abort", onAbort);
    try {
      publishRunOutcome(request.events, workId, runId, result);
    } catch (cause) {
      if (result.status === "succeeded")
        return { status: "failed", error: new RuntimeError(cause) };
    }
    return result;
  })();
  void outcome.then(resolveSettlement);
  if (cancellationRequested) cancellation = settlement;
  return { workId, runId, outcome, cancel };
}
