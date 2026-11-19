// @test-scope ./protocol.ts
import { describe, expect, it } from "vitest";
import { CodexProtocolError } from "./errors.js";
import {
  parseCodexMessage,
  parseInitializeResult,
  parseCodexLaunchConfiguration,
  parseModelListResult,
  parseThreadResult,
  unsupportedCodexServerRequest,
} from "./protocol.js";

describe("Codex app-server protocol", () => {
  it("parses responses, notifications, and server requests", () => {
    expect(
      parseCodexMessage({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
    ).toEqual({
      kind: "response",
      id: 1,
      result: { ok: true },
    });
    expect(parseCodexMessage({ id: 3, result: { ok: true } })).toEqual({
      kind: "response",
      id: 3,
      result: { ok: true },
    });
    expect(parseCodexMessage({ method: "notice", params: {} })).toMatchObject({
      kind: "notification",
      notification: { method: "notice" },
    });
    expect(
      parseCodexMessage({
        jsonrpc: "2.0",
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
        jsonrpc: "2.0",
        id: 2,
        method: "item/commandExecution/requestApproval",
        params: { threadId: "thread-1", turnId: "turn-1" },
      }),
    ).toMatchObject({ kind: "server-request", request: { id: 2 } });
  });

  it("builds a typed rejection for unsupported server requests", () => {
    expect(
      unsupportedCodexServerRequest({
        id: 2,
        method: "item/commandExecution/requestApproval",
        params: {},
      }),
    ).toEqual({
      error: {
        code: -32601,
        message:
          'Unsupported Codex server request "item/commandExecution/requestApproval"',
      },
    });
  });

  it("rejects malformed required payloads", () => {
    expect(() =>
      parseCodexMessage({ jsonrpc: "1.0", id: 1, result: { ok: true } }),
    ).toThrow(CodexProtocolError);
    expect(() =>
      parseCodexMessage({ jsonrpc: "2.0", id: 1, method: "" }),
    ).toThrow(CodexProtocolError);
    expect(() => parseThreadResult({ thread: { id: "" } })).toThrow(
      CodexProtocolError,
    );
  });

  it("validates the typed initialize result", () => {
    expect(
      parseInitializeResult({
        userAgent: "codex-cli/0.147.0",
        codexHome: "/tmp/codex",
        platformFamily: "unix",
        platformOs: "macos",
      }),
    ).toEqual({
      userAgent: "codex-cli/0.147.0",
      codexHome: "/tmp/codex",
      platformFamily: "unix",
      platformOs: "macos",
    });
    expect(() =>
      parseInitializeResult({
        userAgent: "codex-cli/0.147.0",
        codexHome: "/tmp/codex",
      }),
    ).toThrow(CodexProtocolError);
  });

  it("preserves the optional Codex model context window in token usage", () => {
    const tokenUsage = {
      modelContextWindow: 200_000,
      total: {
        totalTokens: 3,
        inputTokens: 2,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 1,
        reasoningOutputTokens: 0,
      },
      last: {
        totalTokens: 3,
        inputTokens: 2,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 1,
        reasoningOutputTokens: 0,
      },
    };

    expect(
      parseCodexMessage({
        jsonrpc: "2.0",
        method: "thread/tokenUsage/updated",
        params: { threadId: "thread-1", turnId: "turn-1", tokenUsage },
      }),
    ).toMatchObject({
      kind: "notification",
      notification: { params: { tokenUsage } },
    });
    expect(() =>
      parseCodexMessage({
        jsonrpc: "2.0",
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: { ...tokenUsage, modelContextWindow: 1.5 },
        },
      }),
    ).toThrow(CodexProtocolError);
  });

  it("preserves accepted native turn, error, and token usage fields", () => {
    const notification = parseCodexMessage({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "failed",
          items: [],
          nativeTurn: { enabled: false, count: 0, label: "" },
          error: {
            message: "request failed",
            nativeError: { retryable: false, code: 0, detail: "" },
          },
        },
      },
    });
    expect(notification).toMatchObject({
      notification: {
        params: {
          turn: {
            nativeTurn: { enabled: false, count: 0, label: "" },
            error: {
              nativeError: { retryable: false, code: 0, detail: "" },
            },
          },
        },
      },
    });

    const usage = {
      total: {
        totalTokens: 1,
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 1,
        reasoningOutputTokens: 0,
        nativeCounts: { enabled: false, count: 0, label: "" },
      },
      last: {
        totalTokens: 1,
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 1,
        reasoningOutputTokens: 0,
      },
      nativeUsage: { enabled: false, count: 0, label: "" },
    };
    expect(
      parseCodexMessage({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: usage,
        },
      }),
    ).toMatchObject({ notification: { params: { tokenUsage: usage } } });

    const delta = {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "message-1",
      delta: "",
      nativeDelta: { enabled: false, count: 0, label: "" },
    };
    expect(
      parseCodexMessage({ method: "item/agentMessage/delta", params: delta }),
    ).toMatchObject({ notification: { params: delta } });
  });

  it("accepts an absolute Windows executable path", () => {
    expect(
      parseCodexLaunchConfiguration(
        {
          executable: String.raw`C:\tools\codex.exe`,
          workspace: String.raw`C:\workspace`,
          networkAccess: false,
        },
        "win32",
      ),
    ).toMatchObject({ executable: String.raw`C:\tools\codex.exe` });
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
