import { z } from "zod";
import type { AgentActivity } from "@seqlane/agent-adapter";
import { AcpLimitError, AcpMalformedStreamError } from "./errors.js";

export const MAX_TOOL_NAME_LENGTH = 256;
export const MAX_TOOL_CALL_ID_LENGTH = 256;
export const MAX_ACTIVITY_COUNT = 1_024;
export const MAX_ACTIVITY_INPUT_LENGTH = 1_000_000;

const boundedToolString = (maximum: number) => z.string().min(1).max(maximum);

const toolCallSchema = z.object({
  type: z.literal("tool-call-delta"),
  payload: z.object({
    toolCallId: boundedToolString(MAX_TOOL_CALL_ID_LENGTH),
    toolName: boundedToolString(MAX_TOOL_NAME_LENGTH),
    argsTextDelta: z.string().optional(),
  }),
});

const toolResultSchema = z.object({
  type: z.literal("tool-result"),
  payload: z.object({
    toolCallId: boundedToolString(MAX_TOOL_CALL_ID_LENGTH),
    toolName: boundedToolString(MAX_TOOL_NAME_LENGTH),
    result: z.unknown().optional(),
    isError: z.boolean().optional(),
  }),
});

type ToolCall = z.output<typeof toolCallSchema>;
type ToolResult = z.output<typeof toolResultSchema>;

function chunkType(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return undefined;
  }
  return typeof value.type === "string" ? value.type : undefined;
}

function parseToolChunk(value: unknown): ToolCall | ToolResult | undefined {
  const type = chunkType(value);
  if (type === "tool-call-delta") {
    const parsed = toolCallSchema.safeParse(value);
    if (!parsed.success) throwStreamParseError(type, parsed.error);
    return parsed.data;
  }
  if (type === "tool-result") {
    const parsed = toolResultSchema.safeParse(value);
    if (!parsed.success) throwStreamParseError(type, parsed.error);
    return parsed.data;
  }
  if (type === undefined && (typeof value !== "object" || value === null)) {
    throw new AcpMalformedStreamError(type);
  }
  return undefined;
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

export function reportAcpStreamChunk(
  value: unknown,
  activities: Map<string, string>,
  onActivity: ((activity: AgentActivity) => void) | undefined,
): void {
  const chunk = parseToolChunk(value);
  if (chunk === undefined) return;

  if (chunk.type === "tool-call-delta") {
    if (
      !activities.has(chunk.payload.toolCallId) &&
      activities.size >= MAX_ACTIVITY_COUNT
    ) {
      throw new AcpLimitError("activity count", MAX_ACTIVITY_COUNT);
    }
    const previousName = activities.get(chunk.payload.toolCallId);
    activities.set(chunk.payload.toolCallId, chunk.payload.toolName);
    onActivity?.({
      activityId: chunk.payload.toolCallId,
      kind: "tool",
      name: chunk.payload.toolName,
      state: previousName === undefined ? "started" : "progress",
      ...(chunk.payload.argsTextDelta === undefined
        ? {}
        : { input: chunk.payload.argsTextDelta }),
    });
    return;
  }

  const previousName = activities.get(chunk.payload.toolCallId);
  if (previousName === undefined || previousName !== chunk.payload.toolName) {
    throw new AcpMalformedStreamError(chunk.type);
  }
  const failed = chunk.payload.isError === true;
  onActivity?.({
    activityId: chunk.payload.toolCallId,
    kind: "tool",
    name: chunk.payload.toolName,
    state: failed ? "failed" : "succeeded",
    ...(chunk.payload.result === undefined
      ? {}
      : { output: chunk.payload.result }),
    ...(failed ? { message: "Tool failed" } : {}),
  });
}
