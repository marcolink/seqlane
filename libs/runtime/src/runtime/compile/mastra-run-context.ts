import { RequestContext } from "@mastra/core/request-context";
import type { Mastra } from "@mastra/core/mastra";
import type {
  InvocationId,
  RunId,
  SeqlaneEventSink,
  WorkId,
} from "@seqlane/core";

/** Mutable safety budget shared by every repeat in one Mastra run. */
export interface RepeatExecutionBudget {
  executed: number;
}

/** Runtime values that must be resolved when a compiled step starts. */
export interface MastraPlanRunContext {
  readonly workId: WorkId;
  readonly runId: RunId;
  readonly resourceId?: string;
  readonly requestContext?: RequestContext;
  readonly mastra?: Mastra;
  readonly events: SeqlaneEventSink;
  readonly repeatBudget: RepeatExecutionBudget;
}

/** Serializable identity carried through a nested Mastra loop snapshot. */
export interface MastraPlanRunIdentity {
  readonly workId: WorkId;
  readonly runId: RunId;
  readonly resourceId?: string;
}

export interface MastraPlanRunContextInput {
  readonly runId: RunId;
  readonly resourceId?: string;
  readonly requestContext?: RequestContext;
  readonly mastra?: Mastra;
  readonly workId?: WorkId;
  readonly events?: SeqlaneEventSink;
  readonly repeatBudget?: RepeatExecutionBudget;
}

export const OPERATIONAL_EVENT_SINK_CONTEXT_KEY =
  "seqlane.operational.eventSink";
export const OPERATIONAL_REPEAT_BUDGET_CONTEXT_KEY =
  "seqlane.operational.repeatBudget";

const NOOP_EVENTS: SeqlaneEventSink = { emit: () => undefined };

function requestContextValue(
  requestContext: RequestContext | undefined,
  key: string,
): unknown {
  return typeof requestContext?.get === "function"
    ? requestContext.get(key)
    : undefined;
}

/**
 * Resolve active identity and transport state from a running Mastra step.
 *
 * The request context is the source of truth for operational runs. The
 * explicit options remain useful for direct compiler users and tests.
 */
export function resolveMastraPlanRunContext(
  input: MastraPlanRunContextInput,
): MastraPlanRunContext {
  const workIdValue =
    requestContextValue(input.requestContext, "seqlane.workId") ?? input.workId;
  const contextEvents = requestContextValue(
    input.requestContext,
    OPERATIONAL_EVENT_SINK_CONTEXT_KEY,
  );
  const contextBudget = requestContextValue(
    input.requestContext,
    OPERATIONAL_REPEAT_BUDGET_CONTEXT_KEY,
  );
  const workId =
    typeof workIdValue === "string" && workIdValue.length > 0
      ? workIdValue
      : (input.resourceId ?? input.runId);
  const activeRequestContext =
    input.requestContext !== undefined &&
    typeof input.requestContext.setRaw === "function"
      ? input.requestContext
      : new RequestContext();
  const budget = (typeof contextBudget === "object" &&
  contextBudget !== null &&
  "executed" in contextBudget
    ? (contextBudget as RepeatExecutionBudget)
    : input.repeatBudget) ?? { executed: 0 };
  const events =
    typeof contextEvents === "object" &&
    contextEvents !== null &&
    "emit" in contextEvents
      ? (contextEvents as SeqlaneEventSink)
      : (input.events ?? NOOP_EVENTS);
  activeRequestContext.setRaw("seqlane.workId", workId);
  activeRequestContext.setRaw("seqlane.runId", input.runId);
  activeRequestContext.setRaw(OPERATIONAL_EVENT_SINK_CONTEXT_KEY, events);
  activeRequestContext.setRaw(OPERATIONAL_REPEAT_BUDGET_CONTEXT_KEY, budget);
  return {
    workId,
    runId: input.runId,
    ...(input.resourceId === undefined ? {} : { resourceId: input.resourceId }),
    requestContext: activeRequestContext,
    ...(input.mastra === undefined ? {} : { mastra: input.mastra }),
    events,
    repeatBudget: budget,
  };
}

export function repeatAttemptInvocationId(
  context: MastraPlanRunContext,
  baseInvocationId: InvocationId,
  iteration: number,
): InvocationId {
  return `${context.runId}:${baseInvocationId}:attempt:${iteration}`;
}
