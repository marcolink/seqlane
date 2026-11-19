import type {
  SessionNotification,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import type { AgentActivity, SeqlaneObservation } from "@seqlane/agent-adapter";
import {
  jsonValueSchema,
  plainRecordSchema,
  type JsonValue,
} from "@seqlane/core";
import { AcpAdapterError, AcpLimitError } from "./errors.js";

export const MAX_TOOL_NAME_LENGTH = 256;
export const MAX_TOOL_CALL_ID_LENGTH = 256;
export const MAX_TOOL_RESULT_BYTES = 1_000_000;
export const MAX_ACTIVITY_COUNT = 1_024;
export const MAX_TOOL_RECORD_COUNT = 1_024;
export const MAX_ACTIVITY_INPUT_LENGTH = 1_000_000;

const MAX_VALUE_DEPTH = 64;
// The snapshot, current update, and optional full notification each preserve
// the same native input/output values. Allow their three serialized copies,
// plus 1 KiB per copy for the fixed ACP envelope and JSON syntax. Other native
// metadata shares this combined projection budget; it is never truncated.
const MAX_ACTIVITY_METADATA_BYTES =
  3 * (MAX_ACTIVITY_INPUT_LENGTH + MAX_TOOL_RESULT_BYTES + 1_024);
const textEncoder = new TextEncoder();

type ToolCall = Extract<SessionUpdate, { sessionUpdate: "tool_call" }>;
type ToolCallUpdate = Extract<
  SessionUpdate,
  { sessionUpdate: "tool_call_update" }
>;
type ToolState = {
  readonly id: string;
  name?: string | null;
  title?: string | null;
  kind?: string | null;
  status?: ToolCall["status"] | ToolCallUpdate["status"];
  snapshot: Record<string, unknown>;
  lastUpdate?: Record<string, unknown>;
  notification?: unknown;
  startedAt: number;
  terminal: boolean;
};

function valueBytes(root: unknown, limit: number): number {
  let bytes = 0;
  let entries = 0;
  const pending: { readonly value: unknown; readonly depth: number }[] = [
    { value: root, depth: 0 },
  ];
  while (pending.length > 0) {
    const item = pending.pop();
    if (item === undefined) continue;
    if (item.depth > MAX_VALUE_DEPTH) {
      throw new AcpLimitError("ACP activity value depth", MAX_VALUE_DEPTH);
    }
    if (typeof item.value === "string") {
      bytes += textEncoder.encode(item.value).byteLength;
    } else if (typeof item.value === "number") {
      if (!Number.isFinite(item.value)) {
        throw new AcpAdapterError(
          "malformed-stream",
          "ACP activity contained a non-finite number",
        );
      }
      bytes += 8;
    } else if (typeof item.value === "boolean" || item.value === null) {
      bytes += 1;
    } else if (Array.isArray(item.value)) {
      entries += item.value.length;
      for (const value of item.value) {
        pending.push({ value, depth: item.depth + 1 });
      }
    } else if (typeof item.value === "object") {
      const properties = Object.entries(item.value);
      entries += properties.length;
      for (const [key, value] of properties) {
        bytes += textEncoder.encode(key).byteLength;
        pending.push({ value, depth: item.depth + 1 });
      }
    } else {
      throw new AcpAdapterError(
        "malformed-stream",
        "ACP activity contained a non-JSON value",
      );
    }
    if (bytes > limit) throw new AcpLimitError("ACP activity value", limit);
    if (entries > MAX_ACTIVITY_COUNT * 16) {
      throw new AcpLimitError(
        "ACP activity value entries",
        MAX_ACTIVITY_COUNT * 16,
      );
    }
  }
  return bytes;
}

function serializedJsonBytes(
  root: JsonValue,
  limit: number,
  field: string,
): number {
  // Call only after jsonValueSchema has accepted the complete source value.
  const serialized = JSON.stringify(root);
  if (serialized === undefined) {
    throw new AcpAdapterError(
      "malformed-stream",
      "ACP JSON value could not be serialized",
    );
  }
  const bytes = textEncoder.encode(serialized).byteLength;
  if (bytes > limit) throw new AcpLimitError(field, limit);
  return bytes;
}

export interface AcpToolReducerSinks {
  readonly onActivity?: (activity: AgentActivity) => void;
  readonly onObservation?: (observation: SeqlaneObservation) => void;
  readonly onDiagnostic?: (diagnostic: {
    readonly code: string;
    readonly message: string;
  }) => void;
}

function toolName(tool: ToolState): string {
  const name = tool.name ?? tool.title ?? "ACP tool call";
  if (name.length === 0) return "ACP tool call";
  if (name.length > MAX_TOOL_NAME_LENGTH) {
    throw new AcpLimitError("tool name", MAX_TOOL_NAME_LENGTH);
  }
  return name;
}

function rawValueMetadata(
  tool: ToolState,
  update: Record<string, unknown>,
  terminalReason?: string,
) {
  const metadata = {
    protocol: "acp-v1",
    snapshot: {
      ...tool.snapshot,
    },
    update,
    ...(tool.notification === undefined
      ? {}
      : { notification: tool.notification }),
    ...(terminalReason === undefined ? {} : { terminalReason }),
  };
  const parsed = jsonValueSchema.safeParse(metadata);
  if (!parsed.success) {
    throw new AcpAdapterError(
      "malformed-stream",
      "ACP tool update contained non-JSON metadata",
      parsed.error,
    );
  }
  valueBytes(parsed.data, Number.POSITIVE_INFINITY);
  return parsed.data;
}

function activityFor(
  tool: ToolState,
  update: Record<string, unknown>,
  state: AgentActivity["state"],
  endedAt?: number,
  message?: string,
  terminalReason?: string,
): AgentActivity {
  if (tool.id.length === 0 || tool.id.length > MAX_TOOL_CALL_ID_LENGTH) {
    throw new AcpLimitError("tool call id", MAX_TOOL_CALL_ID_LENGTH);
  }
  const metadata = rawValueMetadata(tool, update, terminalReason);
  serializedJsonBytes(
    metadata,
    MAX_ACTIVITY_METADATA_BYTES,
    "ACP activity metadata",
  );
  return {
    activityId: tool.id,
    kind: "tool",
    name: toolName(tool),
    state,
    ...(tool.snapshot.rawInput === undefined
      ? {}
      : { input: tool.snapshot.rawInput }),
    ...(tool.snapshot.rawOutput === undefined
      ? {}
      : { output: tool.snapshot.rawOutput }),
    metadata,
    startedAt: tool.startedAt,
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(message === undefined ? {} : { message }),
  };
}

function applyToolPatch(
  tool: ToolState,
  update: ToolCall | ToolCallUpdate,
  rawUpdate: Record<string, unknown>,
  notification?: unknown,
): void {
  tool.lastUpdate = rawUpdate;
  const partialUpdate = update.sessionUpdate === "tool_call_update";
  for (const [key, value] of Object.entries(rawUpdate)) {
    if (
      partialUpdate &&
      value === null &&
      ["name", "title", "kind", "status"].includes(key)
    ) {
      continue;
    }
    tool.snapshot[key] = value;
  }
  if (update.name !== undefined && update.name !== null)
    tool.name = update.name;
  if (update.title !== undefined && update.title !== null)
    tool.title = update.title;
  if ("kind" in update && update.kind !== undefined && update.kind !== null) {
    tool.kind = update.kind;
  }
  if (update.status !== undefined && update.status !== null) {
    tool.status = update.status;
  }
  if (notification !== undefined) tool.notification = notification;
}

function acceptedPayload(
  update: SessionUpdate,
  notification?: SessionNotification,
): {
  readonly update: Record<string, unknown>;
  readonly notification?: JsonValue;
  readonly raw: JsonValue;
} {
  const parsedUpdate = jsonValueSchema.safeParse(update);
  if (!parsedUpdate.success) {
    throw new AcpAdapterError(
      "malformed-stream",
      "ACP update contained a non-JSON value",
      parsedUpdate.error,
    );
  }
  const record = plainRecordSchema.safeParse(parsedUpdate.data);
  if (!record.success) {
    throw new AcpAdapterError(
      "malformed-stream",
      "ACP update was not a JSON object",
    );
  }
  // Preserve the nesting/entry guards without imposing the tool-result byte
  // budget on unrelated update fields such as text or usage.
  valueBytes(record.data, Number.POSITIVE_INFINITY);

  if (notification === undefined) {
    return { update: record.data, raw: parsedUpdate.data };
  }
  const parsedNotification = jsonValueSchema.safeParse(notification);
  if (!parsedNotification.success) {
    throw new AcpAdapterError(
      "malformed-stream",
      "ACP notification contained a non-JSON value",
      parsedNotification.error,
    );
  }
  valueBytes(parsedNotification.data, Number.POSITIVE_INFINITY);
  const notificationRecord = plainRecordSchema.safeParse(
    parsedNotification.data,
  );
  if (!notificationRecord.success) {
    throw new AcpAdapterError(
      "malformed-stream",
      "ACP notification was not an object",
    );
  }
  return {
    update: record.data,
    notification: parsedNotification.data,
    raw: parsedUpdate.data,
  };
}

function statusActivityState(
  status: ToolCall["status"] | ToolCallUpdate["status"] | undefined,
): AgentActivity["state"] | undefined {
  if (status === "completed") return "succeeded";
  if (status === "failed") return "failed";
  if (status === "in_progress") return "progress";
  return undefined;
}

/** Projects typed ACP v1 updates while retaining every native tool payload. */
export class AcpToolReducer {
  private readonly tools = new Map<string, ToolState>();
  private readonly terminalToolIds = new Set<string>();
  private activityCount = 0;
  private toolRecordCount = 0;
  private activityInputBytes = 0;
  private observationCount = 0;

  constructor(
    private readonly invocationId: string,
    private readonly sinks: AcpToolReducerSinks,
  ) {}

  consume(
    update: SessionUpdate,
    notification?: SessionNotification,
  ): string | undefined {
    const accepted = acceptedPayload(update, notification);
    switch (update.sessionUpdate) {
      case "tool_call":
        this.toolCall(update, accepted.update, accepted.notification);
        return undefined;
      case "tool_call_update":
        this.toolCallUpdate(update, accepted.update, accepted.notification);
        return undefined;
      case "agent_message_chunk":
        return update.content.type === "text" ? update.content.text : undefined;
      case "usage_update":
        this.usage(accepted.notification ?? accepted.raw);
        return undefined;
      default:
        return undefined;
    }
  }

  finishAttempt(outcome: "cancelled" | "failed"): void {
    const endedAt = Date.now();
    let callbackFailed = false;
    let callbackFailure: unknown;
    for (const tool of this.tools.values()) {
      if (tool.terminal) continue;
      tool.terminal = true;
      try {
        this.emit(
          activityFor(
            tool,
            tool.lastUpdate ?? tool.snapshot,
            "failed",
            endedAt,
            outcome === "cancelled"
              ? "ACP prompt was cancelled"
              : "ACP prompt ended before the tool reported completion",
            outcome,
          ),
        );
      } catch (cause) {
        if (!callbackFailed) callbackFailure = cause;
        callbackFailed = true;
      } finally {
        this.releaseTool(tool);
      }
    }
    if (callbackFailed) throw callbackFailure;
  }

  private toolCall(
    update: ToolCall,
    rawUpdate: Record<string, unknown>,
    notification?: unknown,
  ): void {
    if (this.terminalToolIds.has(update.toolCallId)) {
      this.diagnoseLateUpdate();
      return;
    }
    this.validateSourcePayload(update);
    if (this.tools.has(update.toolCallId)) {
      const existing = this.tools.get(update.toolCallId);
      if (existing === undefined) return;
      if (existing.terminal) {
        this.diagnoseLateUpdate();
        return;
      }
      applyToolPatch(existing, update, rawUpdate, notification);
      this.toolCallUpdate(
        { ...update, sessionUpdate: "tool_call_update" },
        rawUpdate,
        notification,
        false,
      );
      return;
    }
    if (this.toolRecordCount >= MAX_TOOL_RECORD_COUNT) {
      throw new AcpLimitError("tool record count", MAX_TOOL_RECORD_COUNT);
    }
    this.toolRecordCount += 1;
    const tool: ToolState = {
      id: update.toolCallId,
      snapshot: {},
      startedAt: Date.now(),
      terminal: false,
    };
    applyToolPatch(tool, update, rawUpdate, notification);
    this.tools.set(tool.id, tool);
    const state =
      update.status === "completed" || update.status === "failed"
        ? (statusActivityState(update.status) ?? "failed")
        : "started";
    const terminal = state === "succeeded" || state === "failed";
    if (terminal) tool.terminal = true;
    try {
      this.emit(
        activityFor(tool, rawUpdate, state, terminal ? Date.now() : undefined),
      );
    } finally {
      if (terminal) this.releaseTool(tool);
    }
  }

  private toolCallUpdate(
    update: ToolCallUpdate,
    rawUpdate: Record<string, unknown>,
    notification?: unknown,
    validatePayload = true,
  ): void {
    if (update.toolCallId.length === 0) {
      throw new AcpAdapterError(
        "malformed-stream",
        "ACP tool call id is empty",
      );
    }
    if (this.terminalToolIds.has(update.toolCallId)) {
      this.diagnoseLateUpdate();
      return;
    }
    if (validatePayload) this.validateSourcePayload(update);
    let tool = this.tools.get(update.toolCallId);
    if (tool === undefined) {
      if (this.toolRecordCount >= MAX_TOOL_RECORD_COUNT) {
        throw new AcpLimitError("tool record count", MAX_TOOL_RECORD_COUNT);
      }
      this.toolRecordCount += 1;
      tool = {
        id: update.toolCallId,
        snapshot: {},
        startedAt: Date.now(),
        terminal: false,
      };
      this.tools.set(tool.id, tool);
    }
    if (tool.terminal) {
      this.diagnoseLateUpdate();
      return;
    }
    applyToolPatch(tool, update, rawUpdate, notification);
    const state = statusActivityState(tool.status) ?? "progress";
    const terminal = state === "succeeded" || state === "failed";
    if (terminal) tool.terminal = true;
    try {
      this.emit(
        activityFor(tool, rawUpdate, state, terminal ? Date.now() : undefined),
      );
    } finally {
      if (terminal) this.releaseTool(tool);
    }
  }

  private validateSourcePayload(update: ToolCall | ToolCallUpdate): void {
    if ("rawInput" in update && update.rawInput !== undefined) {
      const bytes = valueBytes(update.rawInput, MAX_ACTIVITY_INPUT_LENGTH);
      if (this.activityInputBytes + bytes > MAX_ACTIVITY_INPUT_LENGTH) {
        throw new AcpLimitError("activity input", MAX_ACTIVITY_INPUT_LENGTH);
      }
      this.activityInputBytes += bytes;
    }
    if ("rawOutput" in update && update.rawOutput !== undefined) {
      const parsed = jsonValueSchema.safeParse(update.rawOutput);
      if (!parsed.success) {
        throw new AcpAdapterError(
          "malformed-stream",
          "ACP tool output contained a non-JSON value",
          parsed.error,
        );
      }
      serializedJsonBytes(parsed.data, MAX_TOOL_RESULT_BYTES, "tool result");
    }
  }

  private releaseTool(tool: ToolState): void {
    this.tools.delete(tool.id);
    this.terminalToolIds.add(tool.id);
    tool.snapshot = {};
    tool.lastUpdate = undefined;
    tool.notification = undefined;
  }

  private usage(usage: JsonValue): void {
    this.observationCount += 1;
    const observedAt = Date.now();
    this.sinks.onObservation?.({
      observationId: `acp-${this.invocationId}-usage-${this.observationCount}`,
      kind: "model",
      state: "updated",
      model: {
        operation: "acp.session.usage",
        usage,
        startedAt: observedAt,
        endedAt: observedAt,
      },
      availability: [
        { path: "model.model", reason: "source-unavailable" },
        { path: "model.provider", reason: "source-unavailable" },
        { path: "model.cost", reason: "source-unavailable" },
      ],
    });
  }

  private diagnoseLateUpdate(): void {
    this.sinks.onDiagnostic?.({
      code: "acp-tool-late-update",
      message: "ACP reported a tool update after a terminal status",
    });
  }

  private emit(activity: AgentActivity): void {
    if (this.activityCount >= MAX_ACTIVITY_COUNT) {
      throw new AcpLimitError("activity count", MAX_ACTIVITY_COUNT);
    }
    this.activityCount += 1;
    this.sinks.onActivity?.(activity);
  }
}
