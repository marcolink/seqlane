import type { SeqlaneExecutionEvent } from "@seqlane/core";

const DEFAULT_MAX_QUEUE_SIZE = 256;
const MAX_DIAGNOSTIC_LENGTH = 200;

export interface EventConsumerRegistration {
  readonly name: string;
  readonly consumer: SeqlaneExecutionEventConsumer;
}

export interface SeqlaneExecutionEventConsumer {
  consume(event: SeqlaneExecutionEvent): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface EventDispatcherOptions {
  readonly maxQueueSize?: number;
  readonly onDiagnostic?: (message: string) => void;
}

export interface EventDispatcher {
  consume(event: SeqlaneExecutionEvent): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

interface ConsumerState extends EventConsumerRegistration {
  readonly queue: SeqlaneExecutionEvent[];
  draining: boolean;
  drainPromise: Promise<void>;
  failed: boolean;
  flushed: boolean;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_DIAGNOSTIC_LENGTH);
}

export function createEventDispatcher(
  registrations: readonly EventConsumerRegistration[],
  options: EventDispatcherOptions = {},
): EventDispatcher {
  const maxQueueSize = Math.max(
    1,
    Math.floor(options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE),
  );
  const states: ConsumerState[] = registrations.map((registration) => ({
    ...registration,
    queue: [],
    draining: false,
    drainPromise: Promise.resolve(),
    failed: false,
    flushed: false,
  }));
  let closed = false;

  const reportFailure = (state: ConsumerState, error: unknown): void => {
    if (state.failed) return;
    state.failed = true;
    state.queue.length = 0;
    try {
      options.onDiagnostic?.(
        `${state.name} consumer disabled: ${errorMessage(error)}`,
      );
    } catch {
      // Diagnostics must not affect runner supervision or exit status.
    }
  };

  const drain = async (state: ConsumerState): Promise<void> => {
    try {
      while (!state.failed && state.queue.length > 0) {
        const event = state.queue.shift();
        if (event === undefined) continue;
        try {
          await state.consumer.consume(event);
        } catch (error) {
          reportFailure(state, error);
        }
      }
    } finally {
      state.draining = false;
    }
  };

  const startDrain = (state: ConsumerState): void => {
    if (state.draining) return;
    state.draining = true;
    state.drainPromise = drain(state);
  };

  const flushConsumer = async (state: ConsumerState): Promise<void> => {
    await state.drainPromise;
    if (state.failed || state.flushed) return;
    try {
      await state.consumer.flush();
      state.flushed = true;
    } catch (error) {
      reportFailure(state, error);
    }
  };

  return {
    consume(event) {
      if (closed) return;
      for (const state of states) {
        if (state.failed) continue;
        if (state.queue.length >= maxQueueSize) {
          reportFailure(state, new Error("event queue is full"));
          continue;
        }
        state.queue.push(event);
        startDrain(state);
      }
    },

    async flush() {
      await Promise.all(states.map(flushConsumer));
    },

    async close() {
      if (closed) return;
      closed = true;
      await Promise.all(states.map(flushConsumer));
      await Promise.all(
        states.map(async (state) => {
          try {
            await state.consumer.close();
          } catch (error) {
            reportFailure(state, error);
          }
        }),
      );
    },
  };
}
