import { z } from "zod";
import type { AgentActivity } from "@seqlane/agent-adapter";
import { AcpLimitError, AcpMalformedStreamError } from "./errors.js";

export const MAX_TOOL_NAME_LENGTH = 256;
export const MAX_TOOL_CALL_ID_LENGTH = 256;
export const MAX_TOOL_RESULT_BYTES = 1_000_000;
export const MAX_ACTIVITY_COUNT = 1_024;
export const MAX_TOOL_RECORD_COUNT = 1_024;
export const MAX_ACTIVITY_INPUT_LENGTH = 1_000_000;

const MAX_DIAGNOSTICS = 8;
const DIAGNOSTICS_SUPPRESSED_CODE = "acp-diagnostics-suppressed";
const DIAGNOSTICS_SUPPRESSED_MESSAGE =
  "ACP v1 suppressed additional tool diagnostics after diagnostic budget exhaustion";

const textEncoder = new TextEncoder();
const boundedToolString = (maximum: number) => z.string().min(1).max(maximum);

/** The ACP v1 stream vocabulary consumed by the private Mastra ACP adapter. */
export const acpV1StreamChunkSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text-delta"),
    payload: z.object({ text: z.string() }),
  }),
  z.object({ type: z.literal("text-start") }),
  z.object({ type: z.literal("text-end") }),
  z.object({ type: z.literal("step-finish") }),
  z.object({ type: z.literal("finish") }),
  z.object({
    type: z.literal("tool-call"),
    payload: z.object({
      toolCallId: boundedToolString(MAX_TOOL_CALL_ID_LENGTH),
      toolName: boundedToolString(MAX_TOOL_NAME_LENGTH),
      args: z.unknown().optional(),
    }),
  }),
  z.object({
    type: z.literal("tool-call-delta"),
    payload: z.object({
      toolCallId: boundedToolString(MAX_TOOL_CALL_ID_LENGTH),
      toolName: boundedToolString(MAX_TOOL_NAME_LENGTH),
      argsTextDelta: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("tool-result"),
    payload: z.object({
      toolCallId: boundedToolString(MAX_TOOL_CALL_ID_LENGTH),
      toolName: boundedToolString(MAX_TOOL_NAME_LENGTH),
      result: z.unknown().optional(),
      isError: z.boolean().optional(),
    }),
  }),
]);

export type AcpV1StreamChunk = z.output<typeof acpV1StreamChunkSchema>;

function chunkType(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return undefined;
  }
  return typeof value.type === "string" ? value.type : undefined;
}

function throwStreamParseError(type: string, cause: z.ZodError): never {
  const limitIssue = cause.issues.find((issue) => issue.code === "too_big");
  if (limitIssue !== undefined) {
    const field = limitIssue.path.at(-1);
    const isCallId = field === "toolCallId";
    throw new AcpLimitError(
      isCallId ? "tool call id" : "tool name",
      isCallId ? MAX_TOOL_CALL_ID_LENGTH : MAX_TOOL_NAME_LENGTH,
      cause,
    );
  }
  throw new AcpMalformedStreamError(type, cause);
}

/** Parse a known ACP v1 chunk exactly once; unknown object chunks are ignored. */
export function parseAcpV1StreamChunk(
  value: unknown,
): AcpV1StreamChunk | undefined {
  const type = chunkType(value);
  if (type === undefined && (typeof value !== "object" || value === null)) {
    throw new AcpMalformedStreamError(type);
  }
  if (
    type !== "text-delta" &&
    type !== "text-start" &&
    type !== "text-end" &&
    type !== "step-finish" &&
    type !== "finish" &&
    type !== "tool-call" &&
    type !== "tool-call-delta" &&
    type !== "tool-result"
  ) {
    return undefined;
  }
  const parsed = acpV1StreamChunkSchema.safeParse(value);
  if (!parsed.success) throwStreamParseError(type, parsed.error);
  return parsed.data;
}

function validateToolResultSize(result: unknown): void {
  if (result === undefined) return;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(result);
  } catch (cause) {
    throw new AcpMalformedStreamError("tool-result", cause);
  }
  if (serialized === undefined) {
    throw new AcpMalformedStreamError("tool-result");
  }
  if (textEncoder.encode(serialized).byteLength > MAX_TOOL_RESULT_BYTES) {
    throw new AcpLimitError("tool result", MAX_TOOL_RESULT_BYTES);
  }
}

export interface AcpToolRecord {
  readonly key: string;
  readonly invocationId: string;
  readonly attemptIndex: number;
  readonly toolCallId: string;
  readonly toolName: string;
  state: "open" | "closed";
  terminalOutcome?: "success" | "failure" | "incomplete" | "cancelled";
}

export type AcpToolTerminalOutcome =
  "success" | "failure" | "incomplete" | "cancelled";

export interface AcpToolReducerSinks {
  readonly onActivity?: (activity: AgentActivity) => void;
  readonly onToolOpened?: (record: AcpToolRecord) => void;
  readonly onToolClosed?: (
    record: AcpToolRecord,
    outcome: AcpToolTerminalOutcome,
  ) => void;
  readonly onDiagnostic?: (diagnostic: {
    readonly code: string;
    readonly message: string;
  }) => void;
}

function tupleKey(
  invocationId: string,
  attemptIndex: number,
  toolCallId: string,
): string {
  return JSON.stringify([invocationId, attemptIndex, toolCallId]);
}

function reportDiagnostic(
  sink: AcpToolReducerSinks,
  code: string,
  message: string,
): void {
  try {
    sink.onDiagnostic?.({ code, message });
  } catch {
    // Diagnostics cannot affect ACP execution.
  }
}

function createBoundedDiagnosticReporter(sinks: AcpToolReducerSinks) {
  let count = 0;
  let suppressionReported = false;
  return (code: string, message: string): void => {
    if (count < MAX_DIAGNOSTICS) {
      count += 1;
      reportDiagnostic(sinks, code, message);
      return;
    }
    if (suppressionReported) return;
    suppressionReported = true;
    reportDiagnostic(
      sinks,
      DIAGNOSTICS_SUPPRESSED_CODE,
      DIAGNOSTICS_SUPPRESSED_MESSAGE,
    );
  };
}

/** Adapter-local ACP v1 lifecycle authority for activity and native spans. */
export class AcpToolReducer {
  private readonly records = new Map<string, AcpToolRecord>();
  private readonly reportDiagnostic: (code: string, message: string) => void;
  private recordCount = 0;
  private activityCount = 0;
  private activityInputLength = 0;

  constructor(
    private readonly invocationId: string,
    private readonly sinks: AcpToolReducerSinks,
  ) {
    this.reportDiagnostic = createBoundedDiagnosticReporter(sinks);
  }

  consume(value: unknown, attemptIndex: number): AcpV1StreamChunk | undefined {
    const chunk = parseAcpV1StreamChunk(value);
    if (chunk === undefined) return undefined;
    if (chunk.type === "tool-call" || chunk.type === "tool-call-delta") {
      this.call(chunk, attemptIndex);
    } else if (chunk.type === "tool-result") {
      this.result(chunk, attemptIndex);
    }
    return chunk;
  }

  finishAttempt(
    attemptIndex: number,
    outcome: "incomplete" | "cancelled" | "failure",
  ): void {
    for (const record of this.records.values()) {
      if (record.attemptIndex !== attemptIndex || record.state !== "open") {
        continue;
      }
      record.state = "closed";
      record.terminalOutcome = outcome;
      this.sinks.onToolClosed?.(record, outcome);
    }
  }

  private call(
    chunk: Extract<AcpV1StreamChunk, { type: "tool-call" | "tool-call-delta" }>,
    attemptIndex: number,
  ): void {
    const { toolCallId, toolName } = chunk.payload;
    const key = tupleKey(this.invocationId, attemptIndex, toolCallId);
    const existing = this.records.get(key);
    if (existing !== undefined) {
      if (existing.state === "closed") {
        this.reportDiagnostic(
          "acp-tool-late-observation",
          "ACP v1 ignored a tool observation after terminal closure",
        );
        return;
      }
      if (existing.toolName !== toolName) {
        this.reportDiagnostic(
          "acp-tool-conflicting-name",
          "ACP v1 ignored a tool observation with a conflicting name",
        );
        return;
      }
      this.emitActivity({
        activityId: toolCallId,
        kind: "tool",
        name: existing.toolName,
        state: "progress",
        ...(chunk.type === "tool-call" && chunk.payload.args !== undefined
          ? { input: chunk.payload.args }
          : chunk.type === "tool-call-delta" &&
              chunk.payload.argsTextDelta !== undefined
            ? { input: chunk.payload.argsTextDelta }
            : {}),
      });
      return;
    }
    if (this.recordCount >= MAX_TOOL_RECORD_COUNT) {
      throw new AcpLimitError("tool record count", MAX_TOOL_RECORD_COUNT);
    }
    this.recordCount += 1;
    const record: AcpToolRecord = {
      key,
      invocationId: this.invocationId,
      attemptIndex,
      toolCallId,
      toolName,
      state: "open",
    };
    this.records.set(key, record);
    this.sinks.onToolOpened?.(record);
    this.emitActivity({
      activityId: toolCallId,
      kind: "tool",
      name: toolName,
      state: "started",
      ...(chunk.type === "tool-call" && chunk.payload.args !== undefined
        ? { input: chunk.payload.args }
        : chunk.type === "tool-call-delta" &&
            chunk.payload.argsTextDelta !== undefined
          ? { input: chunk.payload.argsTextDelta }
          : {}),
    });
  }

  private result(
    chunk: Extract<AcpV1StreamChunk, { type: "tool-result" }>,
    attemptIndex: number,
  ): void {
    const { toolCallId, toolName, result, isError } = chunk.payload;
    const key = tupleKey(this.invocationId, attemptIndex, toolCallId);
    const record = this.records.get(key);
    if (record === undefined) throw new AcpMalformedStreamError(chunk.type);
    const outcome = isError === true ? "failure" : "success";
    if (record.state === "closed") {
      if (record.toolName === toolName && record.terminalOutcome === outcome) {
        return;
      }
      this.reportDiagnostic(
        "acp-tool-conflicting-terminal",
        "ACP v1 ignored a conflicting or late tool terminal observation",
      );
      return;
    }
    if (record.toolName !== toolName) {
      this.reportDiagnostic(
        "acp-tool-conflicting-terminal",
        "ACP v1 ignored a tool terminal observation with a conflicting name",
      );
      return;
    }
    validateToolResultSize(result);
    record.state = "closed";
    record.terminalOutcome = outcome;
    this.sinks.onToolClosed?.(record, outcome);
    this.emitActivity({
      activityId: toolCallId,
      kind: "tool",
      name: toolName,
      state: isError === true ? "failed" : "succeeded",
      ...(result === undefined ? {} : { output: result }),
      ...(isError === true ? { message: "Tool failed" } : {}),
    });
  }

  private emitActivity(activity: AgentActivity): void {
    this.activityCount += 1;
    if (this.activityCount > MAX_ACTIVITY_COUNT) {
      throw new AcpLimitError("activity count", MAX_ACTIVITY_COUNT);
    }
    if (typeof activity.input === "string") {
      this.activityInputLength += activity.input.length;
      if (this.activityInputLength > MAX_ACTIVITY_INPUT_LENGTH) {
        throw new AcpLimitError("activity input", MAX_ACTIVITY_INPUT_LENGTH);
      }
    }
    this.sinks.onActivity?.(activity);
  }
}

interface CompatibilityReducer {
  onActivity?: (activity: AgentActivity) => void;
  readonly reducer: AcpToolReducer;
}

const compatibilityReducers = new WeakMap<
  Map<string, string>,
  CompatibilityReducer
>();

function compatibilityReducer(
  activities: Map<string, string>,
): CompatibilityReducer {
  const existing = compatibilityReducers.get(activities);
  if (existing !== undefined) return existing;

  let initializing = true;
  const reducer = new AcpToolReducer("compatibility", {
    onActivity: (activity) => {
      if (!initializing) context.onActivity?.(activity);
    },
    onToolOpened: (record) =>
      activities.set(record.toolCallId, record.toolName),
  });
  const context: CompatibilityReducer = { reducer };
  compatibilityReducers.set(activities, context);
  for (const [toolCallId, toolName] of activities) {
    reducer.consume(
      {
        type: "tool-call-delta",
        payload: { toolCallId, toolName },
      },
      0,
    );
  }
  initializing = false;
  return context;
}

/** Compatibility helper routed through the canonical ACP v1 reducer. */
export function reportAcpStreamChunk(
  value: unknown,
  activities: Map<string, string>,
  onActivity: ((activity: AgentActivity) => void) | undefined,
): void {
  const context = compatibilityReducer(activities);
  context.onActivity = onActivity;
  context.reducer.consume(value, 0);
}
