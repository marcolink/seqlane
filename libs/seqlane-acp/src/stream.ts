import { z } from "zod";
import type { AgentActivity } from "@seqlane/agent-adapter";
import { AcpMalformedStreamError } from "./errors.js";

const toolCallSchema = z.object({
  type: z.literal("tool-call-delta"),
  payload: z.object({
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    argsTextDelta: z.string().optional(),
  }),
});

const toolResultSchema = z.object({
  type: z.literal("tool-result"),
  payload: z.object({
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
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
    if (!parsed.success) throw new AcpMalformedStreamError(type, parsed.error);
    return parsed.data;
  }
  if (type === "tool-result") {
    const parsed = toolResultSchema.safeParse(value);
    if (!parsed.success) throw new AcpMalformedStreamError(type, parsed.error);
    return parsed.data;
  }
  if (type === undefined && (typeof value !== "object" || value === null)) {
    throw new AcpMalformedStreamError(type);
  }
  return undefined;
}

export function reportAcpStreamChunk(
  value: unknown,
  activities: Map<string, string>,
  onActivity: ((activity: AgentActivity) => void) | undefined,
): void {
  const chunk = parseToolChunk(value);
  if (chunk === undefined) return;

  if (chunk.type === "tool-call-delta") {
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
