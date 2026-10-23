import { describe, expect, it, vi } from "vitest";
import type { RespondToInteraction, UserInputRequest } from "@seqlane/protocol";
import type { ExecutionEventSink } from "../runtime/execution/context.js";
import {
  createUserInputBroker,
  UserInputTimeoutError,
} from "./user-input-broker.js";

type EventInput = Parameters<NonNullable<ExecutionEventSink["emitAsync"]>>[0];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
const question: UserInputRequest = {
  questions: [
    {
      id: "region",
      prompt: "Region?",
      allowFreeText: false,
      options: [
        { value: "eu", label: "Europe" },
        { value: "us", label: "United States" },
      ],
    },
  ],
};
function fixture(
  emitAsync?: (event: EventInput) => Promise<void>,
  timeoutMs = 1000,
) {
  const events: EventInput[] = [];
  const controller = new AbortController();
  const broker = createUserInputBroker({
    workId: "work",
    runId: "run",
    timeoutMs,
    signal: controller.signal,
    events: {
      emit: (event) => events.push(event),
      emitAsync: async (event: EventInput) => {
        events.push(event);
        await emitAsync?.(event);
      },
    },
  });
  const response = (
    invocationId = "invocation",
    answers = { region: "eu" },
  ): RespondToInteraction => {
    const request = events.find(
      (event) =>
        event.type === "interaction.requested" &&
        event.invocationId === invocationId,
    );
    if (request?.type !== "interaction.requested")
      throw new Error("No pending request");
    return {
      type: "interaction.respond",
      runId: "run",
      invocationId,
      requestId: request.requestId,
      answers,
    };
  };
  return { broker, controller, events, response };
}

describe("runtime user input broker", () => {
  it("rejects an invalid answer without consuming the request", async () => {
    const f = fixture();
    const answer = f.broker.requestUserInput("invocation", "task", question);
    await f.broker.respond(f.response("invocation", { region: "asia" }));
    expect(f.events.at(-1)).toMatchObject({
      type: "interaction.response",
      status: "rejected",
      code: "INVALID_ANSWER",
    });
    await f.broker.respond(f.response());
    expect(await answer).toEqual({
      status: "answered",
      answers: { region: "eu" },
    });
    expect(
      f.events.filter((event) => event.type === "interaction.resolved"),
    ).toHaveLength(1);
    await f.broker.close();
  });

  it("admits one answer before an async acknowledgment and deduplicates competing responses", async () => {
    const gate = deferred<void>();
    const f = fixture(async (event) => {
      if (event.type === "interaction.response") await gate.promise;
    });
    const answer = f.broker.requestUserInput("invocation", "task", question);
    const first = f.broker.respond(f.response());
    const duplicate = f.broker.respond(f.response());
    const conflict = f.broker.respond(
      f.response("invocation", { region: "us" }),
    );
    gate.resolve();
    await Promise.all([first, duplicate, conflict]);
    expect(await answer).toMatchObject({ answers: { region: "eu" } });
    expect(
      f.events.filter((event) => event.type === "interaction.resolved"),
    ).toHaveLength(1);
    expect(f.events).toContainEqual(
      expect.objectContaining({ code: "RESPONSE_CONFLICT" }),
    );
    await f.broker.close();
  });

  it("compares duplicate answers independently of property order", async () => {
    const f = fixture();
    const request = {
      questions: [
        { id: "first", prompt: "First?", allowFreeText: true },
        { id: "second", prompt: "Second?", allowFreeText: true },
      ],
    };
    const answer = f.broker.requestUserInput("invocation", "task", request);
    const command = { ...f.response(), answers: { first: "1", second: "2" } };
    await f.broker.respond(command);
    await answer;
    await f.broker.respond({
      ...command,
      answers: { second: "2", first: "1" },
    });
    expect(f.events.at(-1)).toMatchObject({ status: "accepted" });
    await f.broker.close();
  });

  it("routes independent invocations and rejects wrong identities", async () => {
    const f = fixture();
    const one = f.broker.requestUserInput("invocation", "task", question);
    const two = f.broker.requestUserInput("other", "task", question);
    await f.broker.respond({ ...f.response(), runId: "wrong" });
    expect(f.events.at(-1)).toMatchObject({
      runId: "wrong",
      code: "WRONG_RUN",
    });
    await f.broker.respond({ ...f.response(), invocationId: "other" });
    expect(f.events.at(-1)).toMatchObject({ code: "WRONG_INVOCATION" });
    await f.broker.respond({ ...f.response(), requestId: "unknown" });
    expect(f.events.at(-1)).toMatchObject({ code: "UNKNOWN_REQUEST" });
    await f.broker.respond(f.response("other", { region: "us" }));
    await f.broker.respond(f.response());
    expect(await two).toMatchObject({ answers: { region: "us" } });
    expect(await one).toMatchObject({ answers: { region: "eu" } });
    await f.broker.close();
  });

  it("cancels while initial publication is blocked and rejects a late answer", async () => {
    const gate = deferred<void>();
    const f = fixture(async (event) => {
      if (event.type === "interaction.requested") await gate.promise;
    });
    const answer = f.broker.requestUserInput("invocation", "task", question);
    const rejected = expect(answer).rejects.toThrow("cancelled");
    f.controller.abort();
    await rejected;
    await f.broker.respond(f.response());
    expect(f.events.at(-1)).toMatchObject({ code: "REQUEST_CLOSED" });
    gate.resolve();
    await f.broker.close();
  });

  it("preserves cancellation after admission without delivering an answer", async () => {
    const gate = deferred<void>();
    const f = fixture(async (event) => {
      if (event.type === "interaction.response") await gate.promise;
    });
    const answer = f.broker.requestUserInput("invocation", "task", question);
    const rejected = expect(answer).rejects.toThrow("cancelled");
    const responding = f.broker.respond(f.response());
    f.controller.abort();
    gate.resolve();
    await responding;
    await rejected;
    expect(
      f.events.filter((event) => event.type === "interaction.resolved"),
    ).toHaveLength(1);
    await f.broker.close();
  });

  it("expires input even when publication has not acknowledged", async () => {
    const gate = deferred<void>();
    const f = fixture(async (event) => {
      if (event.type === "interaction.requested") await gate.promise;
    }, 10);
    const answer = f.broker.requestUserInput("invocation", "task", question);
    await expect(answer).rejects.toBeInstanceOf(UserInputTimeoutError);
    await f.broker.respond(f.response());
    expect(f.events.at(-1)).toMatchObject({ code: "REQUEST_CLOSED" });
    gate.resolve();
    await f.broker.close();
  });

  it("rejects an answer at the monotonic deadline before the timer callback runs", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const f = fixture();
    try {
      const answer = f.broker.requestUserInput("invocation", "task", question);
      const rejected = expect(answer).rejects.toBeInstanceOf(
        UserInputTimeoutError,
      );
      clock.mockReturnValue(1000);
      await f.broker.respond(f.response());
      await rejected;
      expect(f.events.at(-1)).toMatchObject({ code: "REQUEST_CLOSED" });
    } finally {
      clock.mockRestore();
      await f.broker.close();
    }
  });

  it("observes invocation deadlines separately from run cancellation", async () => {
    const f = fixture();
    const invocation = new AbortController();
    const answer = f.broker.requestUserInput(
      "invocation",
      "task",
      question,
      invocation.signal,
    );
    const timeout = new DOMException("agent deadline", "TimeoutError");
    const rejected = expect(answer).rejects.toBe(timeout);
    invocation.abort(timeout);
    await rejected;
    expect(f.events.at(-1)).toMatchObject({
      type: "interaction.resolved",
      status: "expired",
    });
    expect(f.controller.signal.aborted).toBe(false);
    await f.broker.close();
  });

  it("settles requests after publication and resolution delivery failures", async () => {
    for (const type of ["interaction.requested", "interaction.resolved"]) {
      const f = fixture(async (event) => {
        if (event.type === type) throw new Error("broken channel");
      });
      const answer = f.broker.requestUserInput("invocation", "task", question);
      const rejected = expect(answer).rejects.toThrow();
      if (type === "interaction.resolved") await f.broker.respond(f.response());
      await rejected;
      await f.broker.close();
    }
  });

  it("closes the original wait when the same invocation asks concurrently", async () => {
    const f = fixture();
    const first = f.broker.requestUserInput("invocation", "task", question);
    const rejected = expect(first).rejects.toThrow(
      "CONCURRENT_USER_INPUT_UNSUPPORTED",
    );
    await expect(
      f.broker.requestUserInput("invocation", "task", question),
    ).rejects.toThrow("CONCURRENT_USER_INPUT_UNSUPPORTED");
    await rejected;
    expect(
      f.events.filter((event) => event.type === "interaction.resolved"),
    ).toHaveLength(1);
    await f.broker.close();
  });

  it("retains completed request identities and bounds admissions", async () => {
    const f = fixture();
    for (let i = 0; i < 256; i++) {
      const invocationId = `invocation-${i}`;
      const answer = f.broker.requestUserInput(invocationId, "task", question);
      await f.broker.respond(f.response(invocationId));
      await answer;
    }
    await expect(
      f.broker.requestUserInput("next", "task", question),
    ).rejects.toThrow("USER_INPUT_LIMIT_EXCEEDED");
    await f.broker.respond(f.response("invocation-0"));
    expect(f.events.at(-1)).toMatchObject({ status: "accepted" });
    await f.broker.close();
  });
});
