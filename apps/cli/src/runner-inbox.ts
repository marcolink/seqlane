import { Effect, Queue } from "effect";

const maximumQueuedRunnerMessageCount = 1_024;
const maximumQueuedRunnerMessageBytes = 16 * 1024 * 1024;

export interface RunnerInboxMessage {
  readonly type: string;
  readonly utf8Bytes?: number;
}

export interface RunnerInboxMessageWithBytes extends RunnerInboxMessage {
  readonly utf8Bytes: number;
}

/** Owns bounded native IPC admission and queue accounting for one runner. */
export interface RunnerInbox<Message extends RunnerInboxMessage> {
  readonly take: Effect.Effect<Message>;
  readonly overflowed: boolean;
  offer(message: Message): void;
  offerRunnerMessage(message: Message & RunnerInboxMessageWithBytes): void;
  clearOverflow(): void;
  consume(message: Message): void;
}

export function createRunnerInbox<
  Message extends RunnerInboxMessage,
>(): Effect.Effect<RunnerInbox<Message>> {
  return Effect.gen(function* () {
    const messages = yield* Queue.make<Message>({
      capacity: maximumQueuedRunnerMessageCount,
      strategy: "dropping",
    });
    let overflowed = false;
    let queuedRunnerMessageBytes = 0;

    const markOverflow = (): void => {
      overflowed = true;
    };

    return {
      take: Queue.take(messages),
      get overflowed() {
        return overflowed;
      },
      offer(message) {
        if (!Queue.offerUnsafe(messages, message)) markOverflow();
      },
      offerRunnerMessage(message) {
        if (
          message.utf8Bytes > maximumQueuedRunnerMessageBytes ||
          queuedRunnerMessageBytes + message.utf8Bytes >
            maximumQueuedRunnerMessageBytes
        ) {
          markOverflow();
          return;
        }
        if (Queue.offerUnsafe(messages, message)) {
          queuedRunnerMessageBytes += message.utf8Bytes;
        } else {
          markOverflow();
        }
      },
      clearOverflow() {
        overflowed = false;
      },
      consume(message) {
        if (message.utf8Bytes !== undefined) {
          queuedRunnerMessageBytes -= message.utf8Bytes;
        }
      },
    };
  });
}
