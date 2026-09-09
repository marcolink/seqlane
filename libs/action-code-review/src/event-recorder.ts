import type { SeqlaneEvent } from "@seqlane/core";

type RecordedEvent = {
  readonly event: SeqlaneEvent;
  readonly sequence: number;
  readonly priority: number;
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

/** Bounded, deterministic event retention for Action publication metrics. */
export class BoundedEventRecorder {
  private readonly retained: RecordedEvent[] = [];
  private sequence = 0;
  private didTruncate = false;

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new RangeError("Event recorder limit must be a positive integer.");
  }

  emit(event: SeqlaneEvent): void {
    const entry = {
      event,
      sequence: this.sequence++,
      priority: priority(event),
    };
    if (this.retained.length < this.limit) {
      this.retained.push(entry);
      return;
    }

    this.didTruncate = true;
    let replaceAt = -1;
    for (let index = 0; index < this.retained.length; index += 1) {
      if (
        replaceAt === -1 ||
        this.retained[index]!.priority < this.retained[replaceAt]!.priority
      ) {
        replaceAt = index;
      }
    }
    if (replaceAt !== -1 && entry.priority > this.retained[replaceAt]!.priority)
      this.retained[replaceAt] = entry;
  }

  get events(): readonly SeqlaneEvent[] {
    return [...this.retained]
      .sort((left, right) => left.sequence - right.sequence)
      .map(({ event }) => event);
  }

  get truncated(): boolean {
    return this.didTruncate;
  }
}
