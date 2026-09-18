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
