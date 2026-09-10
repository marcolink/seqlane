import type {
  ObservabilityContext,
  Span,
  SpanType,
} from "@mastra/core/observability";
import { SpanType as MastraSpanType } from "@mastra/core/observability";
import { createBoundedNormalizedNameAllocator } from "@seqlane/agent-adapter";
import type { AcpToolRecord, AcpToolTerminalOutcome } from "./stream.js";

const MAX_INVOCATION_METADATA_LENGTH = 128;
const MAX_DIAGNOSTIC_LENGTH = 256;
const TOOL_NAME_FALLBACK = "ACP v1 tool call";

interface OpenSpan<TSpan extends SpanType> {
  readonly span: Span<TSpan>;
  closed: boolean;
  operationFailed?: boolean;
}

export interface AcpObservability {
  readonly onToolOpened: (record: AcpToolRecord) => void;
  readonly onToolClosed: (
    record: AcpToolRecord,
    outcome: AcpToolTerminalOutcome,
  ) => void;
  readonly finish: (outcome?: "cancelled" | "failed") => void;
}

function bounded(value: string, maximum: number): string {
  return value.length <= maximum ? value : value.slice(0, maximum);
}

function safeDiagnostic(
  onDiagnostic: (message: string) => void,
  message: string,
): void {
  try {
    onDiagnostic(bounded(message, MAX_DIAGNOSTIC_LENGTH));
  } catch {
    // Native diagnostics are best effort and must not recurse.
  }
}

function currentSpan(
  context: Partial<ObservabilityContext>,
  diagnose: (message: string) => void,
): ObservabilityContext["tracing"]["currentSpan"] | undefined {
  try {
    const preferred = context.tracingContext?.currentSpan;
    const fallback = context.tracing?.currentSpan;
    if (
      preferred !== undefined &&
      fallback !== undefined &&
      preferred.id !== fallback.id
    ) {
      diagnose("ACP v1 observability context had conflicting current spans");
      return undefined;
    }
    return preferred ?? fallback;
  } catch {
    diagnose("ACP v1 observability context was unavailable");
    return undefined;
  }
}

function tupleKey(record: AcpToolRecord): string {
  return record.key;
}

function safeError(kind: "incomplete" | "cancelled" | "failed"): Error {
  return new Error(
    kind === "incomplete"
      ? "ACP v1 tool call incomplete"
      : kind === "cancelled"
        ? "ACP v1 tool call cancelled"
        : "ACP v1 tool call failed",
  );
}

function terminalKind(
  outcome: AcpToolTerminalOutcome,
): "incomplete" | "cancelled" | "failed" | undefined {
  if (outcome === "success") return undefined;
  return outcome === "failure" ? "failed" : outcome;
}

/** Adapter-owned ACP v1 projection to native Mastra spans. */
export function createAcpObservability(
  context: Partial<ObservabilityContext>,
  invocationId: string,
  onDiagnostic: (message: string) => void = () => undefined,
): AcpObservability {
  let disabled = false;
  let finished = false;
  let diagnosedDisabled = false;
  let diagnosedNameCardinality = false;
  const tools = new Map<string, OpenSpan<MastraSpanType.TOOL_CALL>>();
  let agent: OpenSpan<MastraSpanType.AGENT_RUN> | undefined;

  const report = (message: string): void =>
    safeDiagnostic(onDiagnostic, message);

  const disable = (operation: string): void => {
    if (disabled) return;
    disabled = true;
    if (!diagnosedDisabled) {
      diagnosedDisabled = true;
      report(
        `ACP v1 native projection disabled after span ${operation} failure`,
      );
    }
    // Best effort, no-throw closure after a native operation failure.
    for (const record of tools.values()) {
      if (record.closed && record.operationFailed !== true) continue;
      record.closed = true;
      try {
        record.span.end();
      } catch {
        // The projection is already disabled.
      }
    }
    tools.clear();
    if (agent !== undefined && !agent.closed) {
      agent.closed = true;
      try {
        agent.span.end();
      } catch {
        // The projection is already disabled.
      }
    } else if (agent?.operationFailed === true) {
      try {
        agent.span.end();
      } catch {
        // The projection is already disabled.
      }
    }
    agent = undefined;
  };

  const parent = currentSpan(context, report);
  try {
    if (parent === undefined || parent.isValid === false) {
      disabled = true;
    } else {
      agent = {
        span: parent.createChildSpan({
          type: MastraSpanType.AGENT_RUN,
          name: "ACP v1 agent run",
          metadata: {
            ...(invocationId.length <= MAX_INVOCATION_METADATA_LENGTH
              ? { "seqlane.invocationId": invocationId }
              : {}),
            "seqlane.adapter": "acp-v1",
          },
        }),
        closed: false,
      };
    }
  } catch {
    disable("create");
  }

  const reportNameCardinality = (): void => {
    if (diagnosedNameCardinality) return;
    diagnosedNameCardinality = true;
    report("ACP v1 tool name cardinality limit reached; using fallback name");
  };
  const toolName = createBoundedNormalizedNameAllocator({
    fallback: TOOL_NAME_FALLBACK,
    onOverflow: reportNameCardinality,
  });

  const closeTool = (
    record: OpenSpan<MastraSpanType.TOOL_CALL>,
    outcome: AcpToolTerminalOutcome,
  ): void => {
    if (disabled || record.closed) return;
    record.closed = true;
    try {
      const kind = terminalKind(outcome);
      if (kind === undefined) {
        record.span.end({ attributes: { success: true } });
      } else if (kind === "failed" && outcome === "failure") {
        record.span.error({
          error: safeError(kind),
          endSpan: true,
          attributes: { success: false },
          metadata: { "seqlane.acp.outcome": "failed" },
        });
      } else {
        record.span.error({
          error: safeError(kind),
          endSpan: true,
          ...(kind === "cancelled" ? { attributes: { success: false } } : {}),
          metadata: { "seqlane.acp.outcome": kind },
        });
      }
    } catch {
      record.operationFailed = true;
      disable("end");
    }
  };

  return {
    onToolOpened(record) {
      if (disabled || agent === undefined || finished) return;
      const name = toolName.resolve(record.toolName);
      try {
        const span = agent.span.createChildSpan({
          type: MastraSpanType.TOOL_CALL,
          name,
          attributes: {
            toolType: "tool",
            toolCallId: record.toolCallId,
          },
          metadata: { "seqlane.attemptIndex": record.attemptIndex },
        });
        tools.set(tupleKey(record), { span, closed: false });
      } catch {
        disable("create");
      }
    },

    onToolClosed(record, outcome) {
      const span = tools.get(tupleKey(record));
      if (span !== undefined) closeTool(span, outcome);
    },

    finish(outcome) {
      if (finished) return;
      finished = true;
      if (disabled) return;
      const toolOutcome =
        outcome === "failed"
          ? ("failure" as const)
          : (outcome ?? ("incomplete" as const));
      for (const record of tools.values()) closeTool(record, toolOutcome);
      tools.clear();
      if (agent === undefined || agent.closed) return;
      agent.closed = true;
      try {
        if (outcome === undefined) agent.span.end();
        else {
          agent.span.error({
            error: new Error(
              outcome === "cancelled"
                ? "ACP v1 agent run cancelled"
                : "ACP v1 agent run failed",
            ),
            endSpan: true,
            metadata: { "seqlane.acp.outcome": outcome },
          });
        }
      } catch {
        agent.operationFailed = true;
        disable("end");
      }
    },
  };
}
