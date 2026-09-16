import type {
  EventDispatcher,
  ExecutionEventConsumer,
} from "./event-dispatcher.js";

export interface RunLifecycleOptions {
  /** The dispatcher owns its registered consumers once it is created. */
  readonly dispatcher?: EventDispatcher;
  /** Used only when dispatcher creation has not completed yet. */
  readonly recordingConsumer?: ExecutionEventConsumer;
  readonly flushEvents?: () => Promise<void>;
  readonly closeClient?: () => void | Promise<void>;
  readonly closeHost?: () => void | Promise<void>;
  readonly finishRenderer?: () => void | Promise<void>;
  readonly beforeCleanup?: () => void;
}

/** Close run resources in dependency order, retaining every cleanup failure. */
export async function closeRunResources(
  options: RunLifecycleOptions,
): Promise<readonly unknown[]> {
  const errors: unknown[] = [];

  const attempt = async (
    operation: (() => void | Promise<void>) | undefined,
  ) => {
    if (operation === undefined) return;
    try {
      await operation();
    } catch (error) {
      errors.push(error);
    }
  };

  await attempt(options.beforeCleanup);
  await attempt(options.closeClient);
  await attempt(options.closeHost);
  await attempt(options.flushEvents);
  if (options.dispatcher !== undefined) {
    await attempt(() => options.dispatcher?.flush());
    await attempt(() => options.dispatcher?.close());
  } else if (options.recordingConsumer !== undefined) {
    await attempt(() => options.recordingConsumer?.flush());
    await attempt(() => options.recordingConsumer?.close());
  }
  if (options.finishRenderer !== undefined) {
    try {
      await options.finishRenderer();
    } catch (error) {
      errors.push(error);
    }
  }

  return errors;
}
