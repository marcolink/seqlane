import type { SeqlaneEvent } from "@seqlane/core";
import {
  projectReviewMetricEvent,
  type ReviewMetricEvent,
  type ReviewRunSkillUsage,
} from "./metrics.js";

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

type SkillSummary = {
  readonly workId: string;
  readonly runId: string;
  readonly invocationId: string;
  readonly sequence: number;
  readonly activities: Map<string, string>;
};

const MAX_SKILL_SUMMARIES = 40;
const MAX_SKILL_ACTIVITIES_PER_SUMMARY = 128;

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
  private readonly skillSummaries = new Map<string, SkillSummary>();
  private sequence = 0;
  private didTruncate = false;

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new RangeError("Event recorder limit must be a positive integer.");
  }

  emit(event: SeqlaneEvent): void {
    const projected = projectReviewMetricEvent(event);
    if (projected === undefined) return;
    const sequence = this.sequence++;
    if (projected.type === "invocation.activity") {
      this.recordSkillActivity(projected, sequence);
      return;
    }
    const entry: RecordedEvent = {
      event: projected,
      sequence,
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
    const retained = [...this.retained].map(({ event, sequence }) => ({
      event,
      sequence,
    }));
    const summaries = [...this.skillSummaries.values()].map((summary) => ({
      event: {
        type: "invocation.skill-summary" as const,
        workId: summary.workId,
        runId: summary.runId,
        invocationId: summary.invocationId,
        skills: summarizeActivities(summary.activities),
      },
      sequence: summary.sequence,
    }));
    return [...retained, ...summaries]
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

  private recordSkillActivity(
    event: Extract<ReviewMetricEvent, { type: "invocation.activity" }>,
    sequence: number,
  ): void {
    let summary = this.skillSummaries.get(event.invocationId);
    if (summary === undefined) {
      if (this.skillSummaries.size >= MAX_SKILL_SUMMARIES) {
        this.didTruncate = true;
        return;
      }
      summary = {
        workId: event.workId,
        runId: event.runId,
        invocationId: event.invocationId,
        sequence,
        activities: new Map(),
      };
      this.skillSummaries.set(event.invocationId, summary);
    }
    if (summary.activities.has(event.activityId)) return;
    if (summary.activities.size >= MAX_SKILL_ACTIVITIES_PER_SUMMARY) {
      this.didTruncate = true;
      return;
    }
    summary.activities.set(event.activityId, event.name);
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

function summarizeActivities(
  activities: ReadonlyMap<string, string>,
): ReviewRunSkillUsage {
  const counts = new Map<string, number>();
  for (const name of activities.values())
    counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => left.name.localeCompare(right.name));
}
