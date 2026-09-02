import type {
  SeqlaneExecutionEvent,
  SeqlaneExecutionEventConsumer,
} from "@seqlane/events";
import type { StudioIngestEvent } from "@seqlane/studio/protocol";

const MAX_QUEUE_SIZE = 256;
const REQUEST_TIMEOUT_MS = 1_000;

export interface StudioPublisherOptions {
  readonly send?: (payload: StudioIngestEvent) => Promise<void>;
  readonly maxQueueSize?: number;
  readonly requestTimeoutMs?: number;
  readonly onDiagnostic?: (message: string) => void;
}

export interface StudioPublisher extends SeqlaneExecutionEventConsumer {
  publish(event: SeqlaneExecutionEvent): void;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 200);
}

async function postStudioEvent(
  address: string,
  payload: StudioIngestEvent,
  timeoutMs: number,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${address}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    await response.arrayBuffer();
    if (!response.ok) {
      throw new Error(`Studio returned HTTP ${response.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

export function createStudioPublisher(
  address: string,
  workflowId: string,
  options: StudioPublisherOptions = {},
): StudioPublisher {
  const queue: SeqlaneExecutionEvent[] = [];
  const maxQueueSize = options.maxQueueSize ?? MAX_QUEUE_SIZE;
  const timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const send =
    options.send ??
    ((payload: StudioIngestEvent) =>
      postStudioEvent(address, payload, timeoutMs));
  let draining = false;
  let drainPromise: Promise<void> = Promise.resolve();
  let closed = false;
  let unavailable = false;
  let diagnosticReported = false;

  const reportFailure = (error: unknown): void => {
    if (diagnosticReported) return;
    diagnosticReported = true;
    unavailable = true;
    queue.length = 0;
    try {
      options.onDiagnostic?.(
        "Studio forwarding disabled: " + errorMessage(error),
      );
    } catch {
      // Diagnostics must not affect runner supervision or exit status.
    }
  };

  const drain = async (): Promise<void> => {
    try {
      while (!unavailable && queue.length > 0) {
        const event = queue.shift();
        if (event === undefined) continue;
        try {
          await send({ workflowId, event });
        } catch (error) {
          reportFailure(error);
        }
      }
    } finally {
      draining = false;
    }
  };

  const startDrain = (): void => {
    if (draining) return;
    draining = true;
    drainPromise = drain();
  };

  return {
    consume(event) {
      if (closed || unavailable) return;
      if (queue.length >= maxQueueSize) {
        reportFailure(new Error("Studio event queue is full"));
        return;
      }
      queue.push(event);
      startDrain();
    },
    publish(event) {
      if (closed || unavailable) return;
      if (queue.length >= maxQueueSize) {
        reportFailure(new Error("Studio event queue is full"));
        return;
      }
      queue.push(event);
      startDrain();
    },
    async flush() {
      await drainPromise;
    },
    async close() {
      closed = true;
      await drainPromise;
    },
  };
}
