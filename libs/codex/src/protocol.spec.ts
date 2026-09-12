// @test-scope ./protocol.ts
import { describe, expect, it } from "vitest";
import { CodexProtocolError } from "./errors.js";
import {
  parseCodexMessage,
  parseModelListResult,
  parseThreadResult,
} from "./protocol.js";

describe("Codex app-server protocol", () => {
  it("parses responses, notifications, and server requests", () => {
    expect(parseCodexMessage({ id: 1, result: { ok: true } })).toEqual({
      kind: "response",
      id: 1,
      result: { ok: true },
    });
    expect(
      parseCodexMessage({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", items: [] },
        },
      }),
    ).toMatchObject({
      kind: "notification",
      notification: { method: "turn/completed" },
    });
    expect(
      parseCodexMessage({
        id: 2,
        method: "item/commandExecution/requestApproval",
        params: { threadId: "thread-1", turnId: "turn-1" },
      }),
    ).toMatchObject({ kind: "server-request", request: { id: 2 } });
  });

  it("rejects malformed required payloads", () => {
    expect(() => parseCodexMessage({ id: 1 })).toThrow(CodexProtocolError);
    expect(() => parseThreadResult({ thread: { id: "" } })).toThrow(
      CodexProtocolError,
    );
  });

  it("normalizes the model catalog used by preflight", () => {
    expect(
      parseModelListResult({
        data: [
          {
            id: "openai/gpt-5.1-codex",
            model: "gpt-5.1-codex",
            supportedReasoningEfforts: [{ reasoningEffort: "high" }],
            isDefault: true,
          },
        ],
      }),
    ).toEqual([
      {
        id: "openai/gpt-5.1-codex",
        model: "gpt-5.1-codex",
        supportedReasoningEfforts: ["high"],
        isDefault: true,
      },
    ]);
  });
});
