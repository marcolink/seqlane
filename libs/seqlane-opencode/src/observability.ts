import type {
  ObservabilityContext,
  Span,
  SpanType,
} from "@mastra/core/observability";
import { SpanType as MastraSpanType } from "@mastra/core/observability";
import { createBoundedNormalizedNameAllocator } from "@seqlane/agent-adapter";
import type {
  OpenCodeAssistantObservation,
  OpenCodeEventObservation,
  OpenCodeTerminalObservation,
  OpenCodeToolObservation,
} from "./observations.js";

const MAX_METADATA_VALUE = 256;
const MAX_INVOCATION_METADATA_LENGTH = 128;
const MAX_PROVIDER_MODEL_IDENTITIES = 128;
const MAX_MODEL_IDENTITIES = 1_024;
const MAX_TOOL_IDENTITIES = 2_048;
const TOOL_NAME_FALLBACK = "OpenCode tool call";

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

function stringField(
  details: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = details[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function skillName(
  observation: OpenCodeToolObservation,
  names: Map<string, string>,
): string | undefined {
  if (observation.tool !== "skill") return undefined;
  const key = tupleKey(observation.messageID, observation.callID);
  const candidate =
    stringField(observation.metadata ?? {}, "name") ??
    stringField(observation.input ?? {}, "name");
  if (candidate === undefined || candidate.length > MAX_METADATA_VALUE)
    return names.get(key);
  names.set(key, candidate);
  return candidate;
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
  try {
    if (cause === undefined) record.span.end();
    else record.span.error({ error: errorFor(cause), endSpan: true });
    record.closed = true;
  } catch {
    // Native observability must never affect executor execution.
    diagnose();
  }
}

function modelAttributes(
  observation: OpenCodeAssistantObservation,
  diagnoseCostUnit: () => void,
  includeProviderModel: boolean,
) {
  const costContext =
    observation.cost === undefined
      ? undefined
      : // OpenCode 1.18.27 exposes a numeric cost but no unit. Do not record
        // an estimated cost without a verified unit.
        (diagnoseCostUnit(), undefined);
  return {
    ...(includeProviderModel
      ? {
          provider: bounded(observation.provider),
          model: bounded(observation.model),
        }
      : {}),
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

function createProviderModelBudget(
  reportDiagnostic: (message: string) => void,
) {
  const identities = new Set<string>();
  let diagnosed = false;
  return (observation: OpenCodeAssistantObservation): boolean => {
    const key = tupleKey(
      bounded(observation.provider),
      bounded(observation.model),
    );
    if (identities.has(key)) return true;
    if (identities.size < MAX_PROVIDER_MODEL_IDENTITIES) {
      identities.add(key);
      return true;
    }
    if (!diagnosed) {
      diagnosed = true;
      reportDiagnostic(
        "OpenCode provider/model cardinality limit reached; omitted provider/model attributes",
      );
    }
    return false;
  };
}

function createToolNameAllocator(reportDiagnostic: (message: string) => void) {
  let diagnosed = false;
  return createBoundedNormalizedNameAllocator({
    fallback: TOOL_NAME_FALLBACK,
    onOverflow: () => {
      if (diagnosed) return;
      diagnosed = true;
      reportDiagnostic(
        "OpenCode tool name cardinality limit reached; using fallback name",
      );
    },
  });
}

/** Creates the adapter-owned OpenCode to Mastra span projection. */
export function createOpenCodeObservability(
  context: Partial<ObservabilityContext>,
  invocationId: string,
  onDiagnostic: (message: string) => void = () => undefined,
): OpenCodeObservability {
  const reportDiagnostic = (message: string): void => {
    try {
      onDiagnostic(bounded(message));
    } catch {
      // Diagnostics are best effort and must not affect execution.
    }
  };
  let diagnosedCostUnit = false;
  const diagnoseCostUnit = (): void => {
    if (diagnosedCostUnit) return;
    diagnosedCostUnit = true;
    reportDiagnostic(
      "OpenCode cost unit is not verified; omitted native cost context",
    );
  };
  const providerModelAttributesAllowed =
    createProviderModelBudget(reportDiagnostic);

  const parent = currentSpan(context, reportDiagnostic);
  if (parent === undefined || parent.isValid === false) {
    return {
      observe: () => undefined,
      observeTerminal: () => undefined,
      finish: () => undefined,
    };
  }

  const models = new Map<string, OpenSpan<ModelSpan>>();
  const tools = new Map<string, OpenSpan<ToolSpan>>();
  const skillNames = new Map<string, string>();
  let disabled = false;
  let finished = false;
  let agent: OpenSpan<AgentSpan> | undefined;
  let fallbackModel: OpenSpan<ModelSpan> | undefined;
  let diagnosedAdditionalFallback = false;
  const toolName = createToolNameAllocator(reportDiagnostic);

  const closeAfterFailure = <TSpan extends SpanType>(
    record: OpenSpan<Span<TSpan>>,
    cause: unknown,
  ): void => {
    if (record.closed) return;
    try {
      record.span.error({ error: errorFor(cause), endSpan: true });
      record.closed = true;
    } catch {
      try {
        record.span.end();
        record.closed = true;
      } catch {
        // Best effort only: exporter failures must not affect execution.
      }
    }
  };

  const disableProjection = (operation: string): void => {
    if (disabled) return;
    disabled = true;
    reportDiagnostic(
      `OpenCode native projection disabled after span ${operation} failure`,
    );
    const cause = new Error("OpenCode native projection disabled");
    for (const record of tools.values()) closeAfterFailure(record, cause);
    for (const record of models.values()) closeAfterFailure(record, cause);
    if (fallbackModel !== undefined) closeAfterFailure(fallbackModel, cause);
    if (agent !== undefined) closeAfterFailure(agent, cause);
    tools.clear();
    models.clear();
    fallbackModel = undefined;
  };

  try {
    agent = {
      span: parent.createChildSpan({
        type: MastraSpanType.AGENT_RUN,
        name: "OpenCode agent run",
        metadata: {
          ...(invocationId.length <= MAX_INVOCATION_METADATA_LENGTH
            ? { "seqlane.invocationId": bounded(invocationId) }
            : {}),
          "seqlane.adapter": "opencode",
        },
      }),
      closed: false,
    };
  } catch {
    disabled = true;
    reportDiagnostic("OpenCode native agent span could not be created");
  }

  if (agent === undefined) {
    return {
      observe: () => undefined,
      observeTerminal: () => undefined,
      finish: () => undefined,
    };
  }

  const admitIdentity = (
    key: string,
    active: ReadonlyMap<string, unknown>,
    limit: number,
    kind: string,
  ): boolean => {
    if (active.has(key)) return true;
    if (active.size >= limit) {
      disableProjection(`${kind} identity limit`);
      return false;
    }
    return true;
  };

  const createModel = (
    observation: OpenCodeAssistantObservation,
  ): OpenSpan<ModelSpan> | undefined => {
    const key = tupleKey(observation.sessionID, observation.messageID);
    const existing = models.get(key);
    if (existing !== undefined) return existing;
    if (!admitIdentity(key, models, MAX_MODEL_IDENTITIES, "model"))
      return undefined;
    try {
      const record = {
        span: agent.span.createChildSpan({
          type: MastraSpanType.MODEL_GENERATION,
          name: "OpenCode model generation",
          startTime: new Date(observation.created),
          attributes: modelAttributes(
            observation,
            diagnoseCostUnit,
            providerModelAttributesAllowed(observation),
          ),
        }),
        closed: false,
      } satisfies OpenSpan<ModelSpan>;
      models.set(key, record);
      return record;
    } catch {
      disableProjection("create");
      return undefined;
    }
  };

  const applyModel = (observation: OpenCodeAssistantObservation): void => {
    const record = createModel(observation);
    if (record === undefined) return;
    safeUpdate(
      record,
      {
        attributes: modelAttributes(
          observation,
          diagnoseCostUnit,
          providerModelAttributesAllowed(observation),
        ),
      },
      () => disableProjection("update"),
    );
    if (isTerminal(observation))
      safeEnd(record, observation.error, () => disableProjection("end"));
  };

  const applyTool = (observation: OpenCodeToolObservation): void => {
    const key = tupleKey(observation.messageID, observation.callID);
    const resolvedName =
      observation.tool === "skill"
        ? (skillName(observation, skillNames) ?? TOOL_NAME_FALLBACK)
        : observation.tool;
    let record = tools.get(key);
    if (record === undefined) {
      if (!admitIdentity(key, tools, MAX_TOOL_IDENTITIES, "tool")) return;
      const model = models.get(
        tupleKey(observation.sessionID, observation.messageID),
      );
      try {
        record = {
          span: (model?.span ?? agent.span).createChildSpan({
            type: MastraSpanType.TOOL_CALL,
            name: toolName.resolve(resolvedName),
            ...(observation.startedAt === undefined
              ? {}
              : { startTime: new Date(observation.startedAt) }),
            attributes: {
              toolType: observation.tool === "skill" ? "skill" : "tool",
              toolCallId: bounded(observation.callID),
            },
          }),
          closed: false,
        };
        tools.set(key, record);
      } catch {
        disableProjection("create");
        return;
      }
    }
    safeUpdate(
      record,
      {
        attributes: {
          ...(observation.tool === "skill"
            ? { toolType: "skill" }
            : { toolType: "tool" }),
          success:
            observation.status === "completed"
              ? true
              : observation.status === "error"
                ? false
                : undefined,
        },
      },
      () => disableProjection("update"),
    );
    if (observation.status === "completed")
      safeEnd(record, undefined, () => disableProjection("end"));
    if (observation.status === "error")
      safeEnd(record, new Error("OpenCode tool failed"), () =>
        disableProjection("end"),
      );
  };

  return {
    observe(observation) {
      if (disabled || finished) return;
      if (observation.kind === "assistant") applyModel(observation);
      else applyTool(observation);
    },
    observeTerminal(observation) {
      if (disabled || finished) return;
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
          disableProjection("end"),
        );
      }
    },
    finish(cause) {
      if (finished) return;
      finished = true;
      if (disabled) return;
      // Close descendants before the adapter run. The workflow-step parent is
      // owned by Mastra and is intentionally never closed here.
      for (const record of tools.values())
        safeEnd(record, cause, () => disableProjection("end"));
      const modelRecords = new Set(models.values());
      for (const record of modelRecords)
        safeEnd(record, cause, () => disableProjection("end"));
      if (fallbackModel !== undefined && !modelRecords.has(fallbackModel)) {
        // Keep an invocation-local fallback in the model closure phase even if
        // its implementation is changed not to use the identity map.
        safeEnd(fallbackModel, cause, () => disableProjection("end"));
      }
      safeEnd(agent, cause, () => disableProjection("end"));
      tools.clear();
      models.clear();
    },
  };
}
