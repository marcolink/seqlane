import type { SeqlaneEvent } from "@seqlane/core";
import { projectReviewMetricEvent, type ReviewMetricEvent } from "./metrics.js";

type RecordedEvent = {
  readonly event: ReviewMetricEvent;
  readonly sequence: number;
  readonly priority: number;
  previous?: RecordedEvent;
  next?: RecordedEvent;
};

type PriorityBucket = {
  head?: RecordedEvent;
  tail?: RecordedEvent;
};

function priority(event: ReviewMetricEvent): number {
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
    event.type === "invocation.output"
  ) {
    return 2;
  }
  if (event.type === "invocation.created") return 1;
  return 0;
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
    const projected = projectReviewMetricEvent(event);
    if (projected === undefined) return;
    const entry: RecordedEvent = {
      event: projected,
      sequence: this.sequence++,
      priority: priority(projected),
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

  get events(): readonly ReviewMetricEvent[] {
    return [...this.retained]
      .sort((left, right) => left.sequence - right.sequence)
      .map(({ event }) => event);
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
