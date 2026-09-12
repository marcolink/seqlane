import type { AgentActivity } from "@seqlane/agent-adapter";
import { CodexAdapterError } from "./errors.js";

export const MAX_TURN_ITEMS = 1_024;
export const MAX_TURN_ITEM_BYTES = 1_000_000;
export const MAX_TURN_ITEMS_BYTES = 8_000_000;

interface ActivityRecord {
  readonly activityId: string;
  readonly name: string;
  readonly input?: unknown;
  readonly startedAt?: number;
}

export class CodexActivityReducer {
  private readonly records = new Map<string, ActivityRecord>();
  private eventCount = 0;
  private eventBytes = 0;

  constructor(private readonly emit: (activity: AgentActivity) => void) {}

  started(item: Record<string, unknown>, startedAt?: number): void {
    const record = this.record(item, startedAt);
    if (record === undefined) return;
    this.consume(item, "started activity");
    const merged = { ...this.records.get(record.activityId), ...record };
    this.records.set(record.activityId, merged);
    this.emit({ ...merged, kind: "tool", state: "started" });
  }

  delta(itemId: string, delta: string): void {
    const record =
      this.records.get(itemId) ??
      ({ activityId: itemId, name: "agentMessage" } satisfies ActivityRecord);
    this.consume({ itemId, delta }, "activity delta");
    this.records.set(itemId, record);
    this.emit({
      activityId: record.activityId,
      kind: "tool",
      name: record.name,
      state: "progress",
      message: delta,
    });
  }

  completed(item: Record<string, unknown>, completedAt?: number): void {
    const record = this.record(item);
    if (record === undefined) return;
    this.consume(item, "completed activity");
    const merged = {
      ...this.records.get(record.activityId),
      ...record,
    };
    this.records.set(record.activityId, merged);
    const failed = item.status === "failed" || item.error !== undefined;
    this.emit({
      ...merged,
      kind: "tool",
      state: failed ? "failed" : "succeeded",
      ...(item.output === undefined ? {} : { output: item.output }),
      ...(completedAt === undefined ? {} : { endedAt: completedAt }),
      ...(failed ? { message: "Tool failed" } : {}),
    });
  }

  private consume(value: unknown, description: string): void {
    if (this.eventCount >= MAX_TURN_ITEMS) {
      throw new CodexAdapterError(
        "limit",
        `Codex turn exceeded ${MAX_TURN_ITEMS} ${description} events`,
      );
    }
    const bytes = boundedJsonBytes(value, description);
    if (
      bytes > MAX_TURN_ITEM_BYTES ||
      this.eventBytes + bytes > MAX_TURN_ITEMS_BYTES
    ) {
      throw new CodexAdapterError(
        "limit",
        `Codex ${description} limit exceeded`,
      );
    }
    this.eventCount += 1;
    this.eventBytes += bytes;
  }

  private record(
    item: Record<string, unknown>,
    startedAt?: number,
  ): ActivityRecord | undefined {
    const activityId = typeof item.id === "string" ? item.id : undefined;
    const name = typeof item.type === "string" ? item.type : undefined;
    if (
      activityId === undefined ||
      name === undefined ||
      name === "agentMessage"
    ) {
      return undefined;
    }
    return {
      activityId,
      name,
      ...(item.input === undefined ? {} : { input: item.input }),
      ...(startedAt === undefined ? {} : { startedAt }),
    };
  }
}

function boundedJsonBytes(value: unknown, description: string): number {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("value is not serializable");
    return Buffer.byteLength(serialized, "utf8");
  } catch (cause) {
    throw new CodexAdapterError(
      "limit",
      `Codex ${description} could not be bounded`,
      cause,
    );
  }
}
