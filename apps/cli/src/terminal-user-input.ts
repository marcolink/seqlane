import {
  encodeRunnerCommand,
  userInputAnswersForRequestSchema,
  type InteractionRequestedEvent,
  type RespondToInteraction,
  type SeqlaneExecutionEvent,
} from "@seqlane/protocol";
import type { UserInputView } from "@seqlane/tui";

interface PendingInput {
  readonly event: InteractionRequestedEvent;
  readonly respond: (command: RespondToInteraction) => Promise<void>;
  readonly cancelRun: () => void;
  submitting: boolean;
  error?: string;
}

export interface TerminalUserInputConsumer {
  bindCancellation(cancelRun: () => void): void;
  readonly onRequested: (
    event: InteractionRequestedEvent,
    respond: (command: RespondToInteraction) => Promise<void>,
    cancelRun: () => void,
  ) => void;
  handle(event: SeqlaneExecutionEvent): void;
  close(): void;
}

/** Owns the FIFO input queue; only canonical events retire requests. */
export function createTerminalUserInputConsumer(
  capabilities: {
    readonly terminal?: {
      readonly stdin: Pick<NodeJS.EventEmitter, "on" | "off">;
    };
  },
  present: (input: UserInputView | undefined) => void,
): TerminalUserInputConsumer {
  const terminal = capabilities.terminal;
  if (terminal === undefined)
    throw new Error("Interactive input requires a terminal");
  const pending = new Map<string, PendingInput>();
  let closed = false;
  let cancelRun: (() => void) | undefined;

  function close(): void {
    if (closed) return;
    closed = true;
    terminal?.stdin.off("end", cancel);
    terminal?.stdin.off("close", cancel);
    pending.clear();
    present(undefined);
  }

  function cancel(): void {
    if (closed) return;
    const first = pending.values().next().value;
    const cancelExecution = cancelRun ?? first?.cancelRun;
    close();
    cancelExecution?.();
  }

  function render(): void {
    const first = pending.values().next().value;
    present(
      first === undefined
        ? undefined
        : {
            requestId: first.event.requestId,
            invocationId: first.event.invocationId,
            questions: first.event.questions,
            pendingCount: pending.size,
            submitting: first.submitting,
            error: first.error,
            onSubmit: (answers) => submit(first, answers),
            onCancel: () => {
              if (pending.values().next().value === first) cancel();
            },
          },
    );
  }

  function submit(entry: PendingInput, answers: Record<string, string>): void {
    if (closed || pending.values().next().value !== entry || entry.submitting)
      return;
    const checked = userInputAnswersForRequestSchema(entry.event).safeParse(
      answers,
    );
    if (!checked.success) {
      entry.error = "Answer every question with a valid value.";
      render();
      return;
    }
    const command: RespondToInteraction = {
      type: "interaction.respond",
      runId: entry.event.runId,
      invocationId: entry.event.invocationId,
      requestId: entry.event.requestId,
      answers: checked.data,
    };
    try {
      encodeRunnerCommand(command);
    } catch {
      entry.error = "Answers exceed the message limit. Shorten the answer.";
      render();
      return;
    }
    entry.submitting = true;
    entry.error = undefined;
    render();
    // A failed write has uncertain delivery. Never retry it automatically.
    void entry.respond(command).catch(() => {
      if (!closed && pending.get(entry.event.requestId) === entry) cancel();
    });
  }

  terminal.stdin.on("end", cancel);
  terminal.stdin.on("close", cancel);
  return {
    bindCancellation(cancelExecution) {
      if (closed) cancelExecution();
      else cancelRun = cancelExecution;
    },
    onRequested(event, respond, cancelRun) {
      if (closed) {
        cancelRun();
        return;
      }
      if (pending.has(event.requestId)) return;
      pending.set(event.requestId, {
        event,
        respond,
        cancelRun,
        submitting: false,
      });
      render();
    },
    handle(event) {
      if (closed) return;
      if (
        event.type === "run.succeeded" ||
        event.type === "run.failed" ||
        event.type === "run.cancelled"
      ) {
        close();
        return;
      }
      if (
        event.type === "interaction.resolved" ||
        event.type === "interaction.response"
      ) {
        const entry = pending.get(event.requestId);
        if (
          entry === undefined ||
          entry.event.runId !== event.runId ||
          entry.event.invocationId !== event.invocationId
        )
          return;
        if (event.type === "interaction.resolved")
          pending.delete(event.requestId);
        else if (event.status === "rejected") {
          if (event.code === "INVALID_ANSWER") {
            entry.submitting = false;
            entry.error = "Answer rejected. Check the values and submit again.";
          } else pending.delete(event.requestId);
        }
        render();
      }
    },
    close,
  };
}
