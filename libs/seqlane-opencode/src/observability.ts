import type {
  ObservabilityContext,
  Span,
  SpanType,
} from "@mastra/core/observability";
import { SpanType as MastraSpanType } from "@mastra/core/observability";
import type {
  OpenCodeAssistantObservation,
  OpenCodeEventObservation,
  OpenCodeTerminalObservation,
  OpenCodeToolObservation,
} from "./observations.js";

const MAX_METADATA_VALUE = 256;

type AgentSpan = Span<MastraSpanType.AGENT_RUN>;
type ModelSpan = Span<MastraSpanType.MODEL_GENERATION>;
type ToolSpan = Span<MastraSpanType.TOOL_CALL>;

interface OpenSpan<TSpan> {
  readonly span: TSpan;
  closed: boolean;
}

export interface OpenCodeObservability {
  readonly observe: (observation: OpenCodeEventObservation) => void;
  readonly observeTerminal: (observation: OpenCodeTerminalObservation) => void;
  readonly finish: (outcome?: OpenCodeObservabilityOutcome | unknown) => void;
}

/** Private adapter outcome used to preserve cancellation semantics in spans. */
export type OpenCodeObservabilityOutcome =
  { readonly kind: "cancelled" } | { readonly kind: "failed" };

function bounded(value: string): string {
  return value.length <= MAX_METADATA_VALUE
    ? value
    : value.slice(0, MAX_METADATA_VALUE);
}

function errorFor(cause: unknown): Error {
  // Executor errors can contain prompts, tool output, or provider transcripts.
  // Keep span failure data stable and bounded instead of forwarding the cause.
  if (
    typeof cause === "object" &&
    cause !== null &&
    "kind" in cause &&
    (cause.kind === "cancelled" || cause.kind === "failed")
  ) {
    return new Error(
      cause.kind === "cancelled"
        ? "OpenCode invocation cancelled"
        : "OpenCode invocation failed",
    );
  }
  return new Error(
    cause === undefined
      ? "OpenCode invocation did not complete"
      : "OpenCode invocation failed",
  );
}

function tupleKey(...values: readonly string[]): string {
  return JSON.stringify(values);
}

function currentSpan(
  context: Partial<ObservabilityContext>,
  diagnose: (message: string) => void,
): ObservabilityContext["tracing"]["currentSpan"] {
  const preferred = context.tracingContext?.currentSpan;
  const fallback = context.tracing?.currentSpan;
  if (
    preferred !== undefined &&
    fallback !== undefined &&
    preferred.id !== fallback.id
  ) {
    diagnose("OpenCode observability context had conflicting current spans");
    return undefined;
  }
  return preferred ?? fallback;
}

function safeUpdate<T extends SpanType>(
  record: OpenSpan<Span<T>>,
  update: Parameters<Span<T>["update"]>[0],
  diagnose: () => void,
): void {
  if (record.closed) return;
  try {
    record.span.update(update);
  } catch {
    // Native observability must never affect executor execution.
    diagnose();
  }
}

function safeEnd<T extends SpanType>(
  record: OpenSpan<Span<T>>,
  cause: unknown | undefined,
  diagnose: () => void,
): void {
  if (record.closed) return;
  record.closed = true;
  try {
    if (cause === undefined) record.span.end();
    else record.span.error({ error: errorFor(cause), endSpan: true });
  } catch {
    // Native observability must never affect executor execution.
    diagnose();
  }
}

function modelAttributes(
  observation: OpenCodeAssistantObservation,
  diagnoseCostUnit: () => void,
) {
  const costContext =
    observation.cost === undefined
      ? undefined
      : // OpenCode 1.18.27 exposes a numeric cost but no unit. Do not record
        // an estimated cost without a verified unit.
        (diagnoseCostUnit(), undefined);
  return {
    provider: bounded(observation.provider),
    model: bounded(observation.model),
    responseId: bounded(observation.messageID),
    ...(observation.finish === undefined
      ? {}
      : { finishReason: bounded(observation.finish) }),
    usage: {
      inputTokens: observation.tokens.input,
      outputTokens: observation.tokens.output,
      inputDetails: {
        cacheRead: observation.tokens.cacheRead,
        cacheWrite: observation.tokens.cacheWrite,
      },
      outputDetails: { reasoning: observation.tokens.reasoning },
    },
    ...(costContext === undefined ? {} : { costContext }),
  };
}

function isTerminal(observation: OpenCodeAssistantObservation): boolean {
  return observation.completed !== undefined || observation.error !== undefined;
}

/** Creates the adapter-owned OpenCode to Mastra span projection. */
export function createOpenCodeObservability(
  context: Partial<ObservabilityContext>,
  invocationId: string,
  onDiagnostic: (message: string) => void = () => undefined,
): OpenCodeObservability {
  const reportDiagnostic = (message: string): void => {
    try {
      onDiagnostic(message);
    } catch {
      // Diagnostics are best effort and must not affect execution.
    }
  };
  let diagnosedCostUnit = false;
  const diagnoseSpanOperation = (operation: string): void => {
    reportDiagnostic(`OpenCode native span ${operation} failed`);
  };
  const diagnoseCostUnit = (): void => {
    if (diagnosedCostUnit) return;
    diagnosedCostUnit = true;
    reportDiagnostic(
      "OpenCode cost unit is not verified; omitted native cost context",
    );
  };

  const parent = currentSpan(context, reportDiagnostic);
  if (parent === undefined || parent.isValid === false) {
    return {
      observe: () => undefined,
      observeTerminal: () => undefined,
      finish: () => undefined,
    };
  }

  let agent: OpenSpan<AgentSpan> | undefined;
  try {
    agent = {
      span: parent.createChildSpan({
        type: MastraSpanType.AGENT_RUN,
        name: "OpenCode agent run",
        metadata: { invocationId: bounded(invocationId), executor: "opencode" },
      }),
      closed: false,
    };
  } catch {
    reportDiagnostic("OpenCode native agent span could not be created");
  }

  if (agent === undefined) {
    return {
      observe: () => undefined,
      observeTerminal: () => undefined,
      finish: () => undefined,
    };
  }

  const models = new Map<string, OpenSpan<ModelSpan>>();
  const tools = new Map<string, OpenSpan<ToolSpan>>();
  let fallbackModel: OpenSpan<ModelSpan> | undefined;
  let diagnosedAdditionalFallback = false;

  const createModel = (
    observation: OpenCodeAssistantObservation,
  ): OpenSpan<ModelSpan> | undefined => {
    const key = tupleKey(observation.sessionID, observation.messageID);
    const existing = models.get(key);
    if (existing !== undefined) return existing;
    try {
      const record = {
        span: agent.span.createChildSpan({
          type: MastraSpanType.MODEL_GENERATION,
          name: "OpenCode model generation",
          startTime: new Date(observation.created),
          attributes: modelAttributes(observation, diagnoseCostUnit),
          metadata: {
            sessionID: bounded(observation.sessionID),
            messageID: bounded(observation.messageID),
          },
        }),
        closed: false,
      } satisfies OpenSpan<ModelSpan>;
      models.set(key, record);
      return record;
    } catch {
      reportDiagnostic("OpenCode native model span could not be created");
      return undefined;
    }
  };

  const applyModel = (observation: OpenCodeAssistantObservation): void => {
    const record = createModel(observation);
    if (record === undefined) return;
    safeUpdate(
      record,
      { attributes: modelAttributes(observation, diagnoseCostUnit) },
      () => diagnoseSpanOperation("update"),
    );
    if (isTerminal(observation))
      safeEnd(record, observation.error, () => diagnoseSpanOperation("end"));
  };

  const applyTool = (observation: OpenCodeToolObservation): void => {
    const key = tupleKey(observation.messageID, observation.callID);
    let record = tools.get(key);
    if (record === undefined) {
      const model = models.get(
        tupleKey(observation.sessionID, observation.messageID),
      );
      try {
        record = {
          span: (model?.span ?? agent.span).createChildSpan({
            type: MastraSpanType.TOOL_CALL,
            name: "OpenCode tool call",
            ...(observation.startedAt === undefined
              ? {}
              : { startTime: new Date(observation.startedAt) }),
            attributes: {
              toolType: observation.tool === "skill" ? "skill" : "tool",
              toolCallId: bounded(observation.callID),
            },
            metadata: {
              messageID: bounded(observation.messageID),
              tool: bounded(observation.tool),
            },
          }),
          closed: false,
        };
        tools.set(key, record);
      } catch {
        reportDiagnostic("OpenCode native tool span could not be created");
        return;
      }
    }
    safeUpdate(
      record,
      {
        attributes: {
          success:
            observation.status === "completed"
              ? true
              : observation.status === "error"
                ? false
                : undefined,
        },
      },
      () => diagnoseSpanOperation("update"),
    );
    if (observation.status === "completed")
      safeEnd(record, undefined, () => diagnoseSpanOperation("end"));
    if (observation.status === "error")
      safeEnd(record, new Error("OpenCode tool failed"), () =>
        diagnoseSpanOperation("end"),
      );
  };

  return {
    observe(observation) {
      if (observation.kind === "assistant") applyModel(observation);
      else applyTool(observation);
    },
    observeTerminal(observation) {
      const key = tupleKey(observation.sessionID, observation.messageID);
      const existing = models.get(key);
      if (existing !== undefined) {
        applyModel(observation);
        return;
      }
      if (fallbackModel !== undefined) {
        if (!diagnosedAdditionalFallback) {
          diagnosedAdditionalFallback = true;
          reportDiagnostic(
            "ignored additional unmatched OpenCode terminal observation",
          );
        }
        return;
      }
      fallbackModel = createModel(observation);
      if (fallbackModel !== undefined && isTerminal(observation)) {
        safeEnd(fallbackModel, observation.error, () =>
          diagnoseSpanOperation("end"),
        );
      }
    },
    finish(cause) {
      // Close descendants before the adapter run. The workflow-step parent is
      // owned by Mastra and is intentionally never closed here.
      for (const record of tools.values())
        safeEnd(record, cause, () => diagnoseSpanOperation("end"));
      const modelRecords = new Set(models.values());
      for (const record of modelRecords)
        safeEnd(record, cause, () => diagnoseSpanOperation("end"));
      if (fallbackModel !== undefined && !modelRecords.has(fallbackModel)) {
        // Keep an invocation-local fallback in the model closure phase even if
        // its implementation is changed not to use the identity map.
        safeEnd(fallbackModel, cause, () => diagnoseSpanOperation("end"));
      }
      safeEnd(agent, cause, () => diagnoseSpanOperation("end"));
    },
  };
}
