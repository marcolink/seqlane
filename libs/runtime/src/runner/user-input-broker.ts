import { createHash, randomUUID } from "node:crypto";
import { Effect } from "effect";
import {
  userInputAnswersForRequestSchema,
  userInputAnswerSchema,
  userInputRequestSchema,
  type RespondToInteraction,
  type UserInputAnswer,
  type UserInputRequest,
} from "@seqlane/protocol";
import type { ExecutionEventSink } from "../runtime/execution/context.js";

type EventInput = Parameters<NonNullable<ExecutionEventSink["emitAsync"]>>[0];
type RejectionCode =
  | "INVALID_ANSWER"
  | "UNKNOWN_REQUEST"
  | "WRONG_INVOCATION"
  | "WRONG_RUN"
  | "REQUEST_CLOSED"
  | "RESPONSE_CONFLICT";
type ClosedState = "cancelled" | "expired" | "failed";

interface RequestIdentity {
  readonly invocationId: string;
  readonly taskId: string;
}
interface PendingInput extends RequestIdentity {
  readonly state: "pending";
  readonly request: UserInputRequest;
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly result: PromiseResolvers<UserInputAnswer>;
  cleanup(): void;
}

interface PromiseResolvers<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function createPromiseResolvers<T>(): PromiseResolvers<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
type InputRecord =
  | PendingInput
  | (RequestIdentity & {
      readonly state: "answered" | ClosedState;
      readonly digest?: string;
    });

export class UserInputTimeoutError extends Error {
  readonly code = "USER_INPUT_TIMEOUT";
  constructor() {
    super("User input deadline expired");
    this.name = "UserInputTimeoutError";
  }
}
export class UserInputCancelledError extends Error {
  constructor() {
    super("User input was cancelled");
    this.name = "UserInputCancelledError";
  }
}
export class UserInputProtocolError extends Error {
  constructor(
    readonly code: string,
    cause?: unknown,
  ) {
    super(code, { cause });
    this.name = "UserInputProtocolError";
  }
}

function answerDigest(answers: RespondToInteraction["answers"]): string {
  const canonical = Object.fromEntries(
    Object.keys(answers)
      .sort()
      .map((key) => [key, answers[key]]),
  );
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Promise boundary for native adapter requests; Effect owns each deadline. */
export function createUserInputBroker(options: {
  readonly workId: string;
  readonly runId: string;
  readonly events: ExecutionEventSink;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}) {
  const records = new Map<string, InputRecord>();
  const invocationRequests = new Map<string, string>();
  const settlements = new Set<Promise<void>>();
  let closed = false;

  const emit = async (event: EventInput): Promise<void> => {
    if (options.events.emitAsync !== undefined)
      await options.events.emitAsync(event);
    else if (
      event.type === "interaction.requested" ||
      event.type === "interaction.response" ||
      event.type === "interaction.resolved"
    ) {
      throw new UserInputProtocolError("USER_INPUT_EVENT_SINK_UNAVAILABLE");
    } else options.events.emit(event);
  };
  const identity = (requestId: string, entry: RequestIdentity) => ({
    workId: options.workId,
    runId: options.runId,
    invocationId: entry.invocationId,
    requestId,
    subject: { type: "task" as const, taskId: entry.taskId },
    taskId: entry.taskId,
  });
  const track = (settlement: Promise<void>): void => {
    settlements.add(settlement);
    void settlement
      .finally(() => settlements.delete(settlement))
      .catch(() => undefined);
  };
  const transition = (
    requestId: string,
    entry: PendingInput,
    state: "answered" | ClosedState,
    digest?: string,
  ): void => {
    // Decide before any async event delivery: exactly one contender wins.
    records.set(requestId, {
      invocationId: entry.invocationId,
      taskId: entry.taskId,
      state,
      ...(digest === undefined ? {} : { digest }),
    });
    invocationRequests.delete(entry.invocationId);
    entry.cleanup();
  };
  const terminate = (
    requestId: string,
    state: ClosedState,
    cause: Error,
    code: string,
    publish = true,
  ): Promise<void> => {
    const entry = records.get(requestId);
    if (entry?.state !== "pending") return Promise.resolve();
    transition(requestId, entry, state);
    const settlement = (async () => {
      let failure: unknown = cause;
      try {
        if (publish)
          await emit({
            type: "interaction.resolved",
            ...identity(requestId, entry),
            status: state,
            code,
          });
      } catch (error) {
        failure = new UserInputProtocolError(
          "USER_INPUT_DELIVERY_FAILED",
          error,
        );
      } finally {
        entry.result.reject(failure);
      }
    })();
    track(settlement);
    return settlement;
  };

  const requestUserInput = async (
    invocationId: string,
    taskId: string,
    rawRequest: UserInputRequest,
    signal: AbortSignal = options.signal,
  ): Promise<UserInputAnswer> => {
    if (closed || options.signal.aborted || signal.aborted)
      throw new UserInputCancelledError();
    const parsed = userInputRequestSchema.safeParse(rawRequest);
    if (!parsed.success)
      throw new UserInputProtocolError("UNSUPPORTED_QUESTION", parsed.error);
    if (records.size >= 256)
      throw new UserInputProtocolError("USER_INPUT_LIMIT_EXCEEDED");
    const existing = invocationRequests.get(invocationId);
    if (existing !== undefined) {
      const failure = new UserInputProtocolError(
        "CONCURRENT_USER_INPUT_UNSUPPORTED",
      );
      await terminate(existing, "failed", failure, failure.code);
      throw failure;
    }
    const requestId = randomUUID();
    const timerController = new AbortController();
    const result = createPromiseResolvers<UserInputAnswer>();
    // Terminal callbacks can settle during event publication.
    void result.promise.catch(() => undefined);
    const onAbort = () => {
      const expired =
        !options.signal.aborted &&
        signal.reason instanceof DOMException &&
        signal.reason.name === "TimeoutError";
      void terminate(
        requestId,
        expired ? "expired" : "cancelled",
        expired ? signal.reason : new UserInputCancelledError(),
        expired ? "EXECUTION_TIMEOUT" : "REQUEST_CLOSED",
      );
    };
    const entry: PendingInput = {
      invocationId,
      taskId,
      state: "pending",
      request: parsed.data,
      signal,
      deadline: performance.now() + options.timeoutMs,
      result,
      cleanup() {
        timerController.abort();
        options.signal.removeEventListener("abort", onAbort);
        signal.removeEventListener("abort", onAbort);
      },
    };
    records.set(requestId, entry);
    invocationRequests.set(invocationId, requestId);
    options.signal.addEventListener("abort", onAbort, { once: true });
    if (signal !== options.signal)
      signal.addEventListener("abort", onAbort, { once: true });
    const publication = emit({
      type: "interaction.requested",
      ...identity(requestId, entry),
      kind: "user-input",
      questions: parsed.data.questions,
      expiresAt: new Date(Date.now() + options.timeoutMs).toISOString(),
    });
    void publication.catch((cause) =>
      terminate(
        requestId,
        "failed",
        new UserInputProtocolError("USER_INPUT_DELIVERY_FAILED", cause),
        "USER_INPUT_DELIVERY_FAILED",
        false,
      ),
    );
    // Install at registration, not after the consumer acknowledges publication.
    const timer = Effect.runPromise(Effect.sleep(options.timeoutMs), {
      signal: timerController.signal,
    });
    void timer.then(
      () =>
        terminate(
          requestId,
          "expired",
          new UserInputTimeoutError(),
          "USER_INPUT_TIMEOUT",
        ),
      () => undefined,
    );
    if (options.signal.aborted || signal.aborted) onAbort();
    return result.promise;
  };

  const rejectResponse = (command: RespondToInteraction, code: RejectionCode) =>
    emit({
      type: "interaction.response",
      workId: options.workId,
      runId: command.runId,
      invocationId: command.invocationId,
      requestId: command.requestId,
      status: "rejected",
      code,
    });
  const acceptResponse = (command: RespondToInteraction) =>
    emit({
      type: "interaction.response",
      workId: options.workId,
      runId: command.runId,
      invocationId: command.invocationId,
      requestId: command.requestId,
      status: "accepted",
    });
  const respond = async (command: RespondToInteraction): Promise<void> => {
    if (command.runId !== options.runId)
      return rejectResponse(command, "WRONG_RUN");
    const entry = records.get(command.requestId);
    if (entry === undefined) return rejectResponse(command, "UNKNOWN_REQUEST");
    if (entry.invocationId !== command.invocationId)
      return rejectResponse(command, "WRONG_INVOCATION");
    if (entry.state === "answered") {
      return entry.digest === answerDigest(command.answers)
        ? acceptResponse(command)
        : rejectResponse(command, "RESPONSE_CONFLICT");
    }
    if (entry.state !== "pending")
      return rejectResponse(command, "REQUEST_CLOSED");
    if (closed || options.signal.aborted || entry.signal.aborted) {
      await terminate(
        command.requestId,
        "cancelled",
        new UserInputCancelledError(),
        "REQUEST_CLOSED",
      );
      return rejectResponse(command, "REQUEST_CLOSED");
    }
    if (performance.now() >= entry.deadline) {
      await terminate(
        command.requestId,
        "expired",
        new UserInputTimeoutError(),
        "USER_INPUT_TIMEOUT",
      );
      return rejectResponse(command, "REQUEST_CLOSED");
    }
    const answers = userInputAnswersForRequestSchema(entry.request).safeParse(
      command.answers,
    );
    if (!answers.success) return rejectResponse(command, "INVALID_ANSWER");
    transition(
      command.requestId,
      entry,
      "answered",
      answerDigest(answers.data),
    );
    // Queue both events before allowing another terminal callback to run.
    const acknowledgment = acceptResponse(command);
    const resolution = emit({
      type: "interaction.resolved",
      ...identity(command.requestId, entry),
      status: "answered",
    });
    const settlement = (async () => {
      try {
        await Promise.all([acknowledgment, resolution]);
        if (closed || options.signal.aborted || entry.signal.aborted)
          throw new UserInputCancelledError();
        entry.result.resolve(
          userInputAnswerSchema.parse({
            status: "answered",
            answers: answers.data,
          }),
        );
      } catch (cause) {
        entry.result.reject(cause);
      }
    })();
    track(settlement);
    await settlement;
  };
  const close = async (): Promise<void> => {
    closed = true;
    for (const [requestId, entry] of records) {
      if (entry.state === "pending")
        void terminate(
          requestId,
          "cancelled",
          new UserInputCancelledError(),
          "REQUEST_CLOSED",
        );
    }
    await Promise.all([...settlements]);
    records.clear();
  };
  return { requestUserInput, respond, close };
}
