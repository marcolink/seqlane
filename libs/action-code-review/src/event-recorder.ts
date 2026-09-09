import type { JsonValue, SeqlaneEvent } from "@seqlane/core";

type RecordedEvent = {
  readonly event: SeqlaneEvent;
  readonly sequence: number;
  readonly priority: number;
  previous?: RecordedEvent;
  next?: RecordedEvent;
};

type PriorityBucket = {
  head?: RecordedEvent;
  tail?: RecordedEvent;
};

function priority(event: SeqlaneEvent): number {
  if (
    event.type === "run.succeeded" ||
    event.type === "run.failed" ||
    event.type === "run.cancelled"
  ) {
    return 3;
  }
  if (
    event.type === "invocation.succeeded" ||
    event.type === "invocation.failed" ||
    event.type === "invocation.skipped" ||
    event.type === "invocation.cancelled" ||
    (event.type === "invocation.output" && event.metrics !== undefined)
  ) {
    return 2;
  }
  if (event.type === "invocation.created") return 1;
  return 0;
}

function serializeJsonValue(value: unknown): JsonValue {
  if (value === null) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (value instanceof Error) {
    const error = value as Error & {
      readonly category?: unknown;
      readonly taskId?: unknown;
      readonly nodeId?: unknown;
      readonly sourceId?: unknown;
      readonly maximumIterations?: unknown;
      readonly issues?: unknown;
      readonly evidence?: unknown;
    };
    const serialized: Record<string, JsonValue> = {
      category:
        typeof error.category === "string" ? error.category : "RuntimeError",
      message: error.message,
      name: error.name,
    };
    for (const key of [
      "taskId",
      "nodeId",
      "sourceId",
      "maximumIterations",
      "issues",
      "evidence",
    ] as const) {
      const field = error[key];
      if (field !== undefined) serialized[key] = serializeJsonValue(field);
    }
    return serialized;
  }
  if (Array.isArray(value)) {
    return value.map((entry) =>
      entry === undefined ? null : serializeJsonValue(entry),
    );
  }
  if (typeof value === "object") {
    const serialized: Record<string, JsonValue> = {};
    for (const key of Object.keys(value)) {
      const field = (value as Record<string, unknown>)[key];
      if (field !== undefined) serialized[key] = serializeJsonValue(field);
    }
    return serialized;
  }
  throw new TypeError("Cannot serialize a non-JSON event value.");
}

/** Bounded, deterministic event retention for Action publication metrics. */
export class BoundedEventRecorder {
  private readonly retained = new Set<RecordedEvent>();
  private readonly buckets: PriorityBucket[] = [{}, {}, {}, {}];
  private sequence = 0;
  private didTruncate = false;

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new RangeError("Event recorder limit must be a positive integer.");
  }

  emit(event: SeqlaneEvent): void {
    const entry: RecordedEvent = {
      event,
      sequence: this.sequence++,
      priority: priority(event),
    };
    if (this.retained.size < this.limit) {
      this.retain(entry);
      return;
    }

    this.didTruncate = true;
    const lowest = this.lowestRetained();
    if (lowest === undefined || entry.priority <= lowest.priority) return;
    this.remove(lowest);
    this.retain(entry);
  }

  get events(): readonly SeqlaneEvent[] {
    return [...this.retained]
      .sort((left, right) => left.sequence - right.sequence)
      .map(({ event }) => event);
  }

  /** Returns retained events as plain JSON values, including serialized errors. */
  get serializedEvents(): readonly JsonValue[] {
    return this.events.map((event) => serializeJsonValue(event));
  }

  get truncated(): boolean {
    return this.didTruncate;
  }

  private retain(entry: RecordedEvent): void {
    const bucket = this.buckets[entry.priority]!;
    if (bucket.tail === undefined) {
      bucket.head = entry;
      bucket.tail = entry;
    } else {
      bucket.tail.next = entry;
      entry.previous = bucket.tail;
      bucket.tail = entry;
    }
    this.retained.add(entry);
  }

  private remove(entry: RecordedEvent): void {
    const bucket = this.buckets[entry.priority]!;
    if (entry.previous === undefined) bucket.head = entry.next;
    else entry.previous.next = entry.next;
    if (entry.next === undefined) bucket.tail = entry.previous;
    else entry.next.previous = entry.previous;
    entry.previous = undefined;
    entry.next = undefined;
    this.retained.delete(entry);
  }

  private lowestRetained(): RecordedEvent | undefined {
    for (const bucket of this.buckets) {
      if (bucket.head !== undefined) return bucket.head;
    }
    return undefined;
  }
}
