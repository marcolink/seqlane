// @test-scope ./user-input.ts ./validation.ts ./runner-protocol.ts ./serialization.ts
import { describe, expect, it } from "vitest";
import { decodeRunnerCommand } from "./runner-protocol.js";
import { decodeSeqlaneExecutionEvent } from "./serialization.js";

const identity = {
  workId: "work",
  runId: "run",
  invocationId: "invocation",
  requestId: "request",
};
const metadata = {
  schemaVersion: 1,
  eventId: "event",
  sequence: 0,
  occurredAt: "2026-10-23T21:00:00.000Z",
};
const question = { id: "region", prompt: "Region?", allowFreeText: true };
const request = {
  ...identity,
  metadata,
  type: "interaction.requested",
  subject: { type: "task", taskId: "choose" },
  taskId: "choose",
  kind: "user-input",
  questions: [question],
  expiresAt: "2026-10-23T21:05:00.000Z",
};

describe("interaction wire boundaries", () => {
  it("round trips the runtime question and its answer command", () => {
    expect(decodeSeqlaneExecutionEvent(JSON.stringify(request))).toEqual(
      request,
    );
    const response = {
      type: "interaction.respond",
      runId: identity.runId,
      invocationId: identity.invocationId,
      requestId: identity.requestId,
      answers: { region: "eu-west" },
    };
    expect(decodeRunnerCommand(JSON.stringify(response))).toEqual(response);
  });

  it.each([
    [question, question],
    [{ ...question, allowFreeText: false }],
    [
      {
        ...question,
        options: [
          { value: "east", label: "East" },
          { value: "east", label: "Other east" },
        ],
      },
    ],
    [{ ...question, id: "constructor" }],
    [{ ...question, prompt: "  " }],
  ])(
    "applies canonical question validation on incoming events: %j",
    (...questions) => {
      expect(() =>
        decodeSeqlaneExecutionEvent(
          JSON.stringify({
            ...request,
            questions,
          }),
        ),
      ).toThrow("Invalid Seqlane execution event");
    },
  );

  it("includes envelope fields in the 64 KiB request limit", () => {
    expect(() =>
      decodeSeqlaneExecutionEvent(
        JSON.stringify({
          ...request,
          requestId: "x".repeat(64 * 1024),
        }),
      ),
    ).toThrow("Invalid Seqlane execution event");
  });

  it("bounds response bytes, including multibyte text and envelope fields", () => {
    const response = {
      type: "interaction.respond",
      runId: identity.runId,
      invocationId: identity.invocationId,
      requestId: identity.requestId,
      answers: Object.fromEntries(
        Array.from({ length: 8 }, (_, i) => [`question${i}`, "é".repeat(8192)]),
      ),
    };
    expect(() => decodeRunnerCommand(JSON.stringify(response))).toThrow(
      "Invalid runner command",
    );
    expect(() =>
      decodeRunnerCommand(
        JSON.stringify({
          ...response,
          answers: { region: "eu-west" },
          requestId: "x".repeat(64 * 1024),
        }),
      ),
    ).toThrow("Invalid runner command");
  });

  it("requires rejection reasons and rejects contradictory accepted acknowledgments", () => {
    const response = { ...identity, metadata, type: "interaction.response" };
    expect(() =>
      decodeSeqlaneExecutionEvent(
        JSON.stringify({
          ...response,
          status: "rejected",
        }),
      ),
    ).toThrow("Invalid Seqlane execution event");
    expect(() =>
      decodeSeqlaneExecutionEvent(
        JSON.stringify({
          ...response,
          status: "accepted",
          code: "INVALID_ANSWER",
        }),
      ),
    ).toThrow("Invalid Seqlane execution event");
    expect(
      decodeSeqlaneExecutionEvent(
        JSON.stringify({
          ...response,
          status: "rejected",
          code: "UNKNOWN_REQUEST",
        }),
      ),
    ).toMatchObject({ status: "rejected", code: "UNKNOWN_REQUEST" });
  });
});
