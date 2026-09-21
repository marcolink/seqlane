// @test-scope ./observations.ts
import { describe, expect, it } from "vitest";
import {
  parseOpenCodeEvent,
  parseOpenCodeMessageObservations,
  parseOpenCodeObservation,
} from "./observations.js";

const assistant = (sessionID: string, id = "message-1") => ({
  id,
  sessionID,
  role: "assistant",
  time: { created: 1, completed: 2 },
  modelID: "model",
  providerID: "provider",
  cost: 0,
  tokens: {
    input: 1,
    output: 2,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  },
});

describe("OpenCode observation validation", () => {
  it("parses assistant tool parts from the session message list", () => {
    const parsed = parseOpenCodeMessageObservations(
      [
        {
          info: assistant("session-1", "assistant-1"),
          parts: [
            {
              id: "part-1",
              sessionID: "session-1",
              messageID: "assistant-1",
              type: "tool",
              callID: "call-1",
              tool: "filesystem.read",
              state: {
                status: "completed",
                input: { path: "/repo/package.json" },
                output: "{}",
                metadata: { source: "message-list" },
                time: { start: 1, end: 2 },
              },
            },
          ],
        },
      ],
      "session-1",
    );

    expect(parsed).toEqual({
      messageIDs: ["assistant-1"],
      observations: [
        expect.objectContaining({
          kind: "tool",
          messageID: "assistant-1",
          callID: "call-1",
          status: "completed",
          input: { path: "/repo/package.json" },
          output: "{}",
        }),
      ],
      malformedPartCount: 0,
    });
  });

  it("parses one typed assistant and tool observation", () => {
    const message = parseOpenCodeEvent(
      {
        type: "message.updated",
        properties: { sessionID: "session-1", info: assistant("session-1") },
      },
      "session-1",
    );
    const tool = parseOpenCodeObservation(
      {
        type: "message.part.updated",
        properties: {
          sessionID: "session-1",
          part: {
            id: "part-1",
            sessionID: "session-1",
            messageID: "message-1",
            type: "tool",
            callID: "call-1",
            tool: "filesystem.read",
            state: {
              status: "completed",
              input: { path: "/repo/package.json" },
              output: "ok",
              metadata: { private: true },
              time: { start: 1, end: 2 },
            },
          },
        },
      },
      "session-1",
    );

    expect(message?.observation).toMatchObject({
      kind: "assistant",
      messageID: "message-1",
    });
    expect(tool).toMatchObject({
      kind: "tool",
      messageID: "message-1",
      callID: "call-1",
      status: "completed",
    });
  });

  it("classifies malformed, unsupported, and cross-session events without observations", () => {
    const malformed = parseOpenCodeEvent(
      { type: "message.updated", properties: { sessionID: "session-1" } },
      "session-1",
    );
    const unsupported = parseOpenCodeEvent(
      {
        type: "message.updated",
        properties: {
          sessionID: "session-1",
          info: { id: "user-1", sessionID: "session-1", role: "user" },
        },
      },
      "session-1",
    );
    const otherSession = parseOpenCodeEvent(
      {
        type: "message.updated",
        properties: { sessionID: "session-2", info: assistant("session-2") },
      },
      "session-1",
    );
    const mismatchedEnvelope = parseOpenCodeEvent(
      {
        type: "message.updated",
        properties: {
          sessionID: "session-1",
          info: assistant("session-2"),
        },
      },
      "session-1",
    );

    expect(malformed?.validity).toBe("malformed");
    expect(malformed?.observation).toBeUndefined();
    expect(unsupported?.validity).toBe("unsupported");
    expect(unsupported?.observation).toBeUndefined();
    expect(otherSession?.sessionMatches).toBe(false);
    expect(otherSession?.observation).toBeUndefined();
    expect(mismatchedEnvelope?.sessionMatches).toBe(false);
    expect(mismatchedEnvelope?.observation).toBeUndefined();
  });

  it("keeps legacy tool callbacks typed while excluding them from native observations", () => {
    const parsed = parseOpenCodeEvent(
      {
        type: "message.part.updated",
        properties: {
          sessionID: "session-1",
          part: {
            type: "tool",
            callID: "call-1",
            tool: "skill",
            state: {
              status: "completed",
              input: { name: "lint" },
              output: "loaded",
              time: { start: 1, end: 2 },
            },
          },
        },
      },
      "session-1",
    );

    expect(parsed?.validity).toBe("valid");
    expect(parsed?.observation).toBeUndefined();
    expect(parsed?.legacyTool).toMatchObject({
      sessionID: "session-1",
      callID: "call-1",
      status: "completed",
    });
  });

  it("retains assistant message identity for legacy tool events", () => {
    const withAssistantMessage = parseOpenCodeEvent(
      {
        type: "session.next.tool.called",
        properties: {
          sessionID: "session-1",
          assistantMessageID: "assistant-1",
          callID: "call-1",
          tool: "ripwire_grep",
        },
      },
      "session-1",
    );
    const withoutAssistantMessage = parseOpenCodeEvent(
      {
        type: "session.next.tool.success",
        properties: {
          sessionID: "session-1",
          callID: "call-1",
        },
      },
      "session-1",
    );

    expect(withAssistantMessage?.legacyTool).toMatchObject({
      messageID: "assistant-1",
    });
    expect(withoutAssistantMessage?.legacyTool?.messageID).toBeUndefined();
  });

  it("rejects oversized legacy tool identifiers", () => {
    const parsed = parseOpenCodeEvent(
      {
        type: "message.part.updated",
        properties: {
          sessionID: "session-1",
          part: {
            type: "tool",
            callID: "c".repeat(257),
            tool: "ripwire_grep",
            state: { status: "running" },
          },
        },
      },
      "session-1",
    );

    expect(parsed?.validity).toBe("malformed");
    expect(parsed?.legacyTool).toBeUndefined();
  });
});
