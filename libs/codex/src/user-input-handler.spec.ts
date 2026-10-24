// @test-scope ./user-input-handler.ts
import { describe, expect, it, vi } from "vitest";
import type { UserInputRequest } from "@seqlane/agent-adapter";
import { createCodexUserInputHandler } from "./user-input-handler.js";

const question = {
  questions: [{ id: "region", prompt: "Region?", allowFreeText: true }],
};

function request(id: number, argumentsValue: unknown = question) {
  return {
    id,
    method: "item/tool/call",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: `call-${id}`,
      namespace: null,
      tool: "ask_user",
      arguments: argumentsValue,
    },
  } as const;
}

function createHandler(
  onUserInput?: (value: UserInputRequest) => Promise<string>,
  signal?: AbortSignal,
) {
  const respond = vi.fn();
  const fail = vi.fn();
  const handler = createCodexUserInputHandler({
    threadId: "thread-1",
    turnId: "turn-1",
    onUserInput,
    respond,
    signal,
    fail,
  });
  return { handler, respond, fail };
}

describe("Codex user input handler", () => {
  it("rejects malformed questions and fails the native turn", () => {
    const { handler, respond, fail } = createHandler(vi.fn());

    expect(handler.handle(request(1, { questions: [] }))).toBe(true);
    expect(handler.pendingCallCount).toBe(0);
    expect(respond).toHaveBeenCalledWith(1, {
      error: { code: -32602, message: "Unsupported user input question" },
    });
    expect(fail).toHaveBeenCalledWith(
      expect.objectContaining({ code: "user-input.unsupported" }),
    );
  });

  it("tracks repeated questions independently until each answer is written", async () => {
    const resolveAnswers: Array<(answer: string) => void> = [];
    const { handler, respond } = createHandler(
      () => new Promise((resolve) => resolveAnswers.push(resolve)),
    );

    handler.handle(request(1));
    handler.handle(request(2));
    expect(handler.pendingCallCount).toBe(2);

    resolveAnswers[0]?.("Europe");
    await Promise.resolve();
    expect(handler.pendingCallCount).toBe(1);
    resolveAnswers[1]?.("Asia");
    await Promise.resolve();
    expect(handler.pendingCallCount).toBe(0);
    expect(respond).toHaveBeenNthCalledWith(1, 1, {
      result: {
        contentItems: [{ type: "inputText", text: "Europe" }],
        success: true,
      },
    });
    expect(respond).toHaveBeenNthCalledWith(2, 2, {
      result: {
        contentItems: [{ type: "inputText", text: "Asia" }],
        success: true,
      },
    });
  });

  it("drops pending calls and late answers after cancellation", async () => {
    const controller = new AbortController();
    let resolveAnswer!: (answer: string) => void;
    const { handler, respond } = createHandler(
      () => new Promise((resolve) => (resolveAnswer = resolve)),
      controller.signal,
    );

    handler.handle(request(1));
    controller.abort();
    expect(handler.pendingCallCount).toBe(0);
    resolveAnswer("late");
    await Promise.resolve();
    expect(respond).not.toHaveBeenCalled();
    handler.handle(request(2));
    expect(handler.pendingCallCount).toBe(0);
    expect(respond).not.toHaveBeenCalled();
  });

  it("fails disabled calls without guessing an answer", () => {
    const { handler, respond, fail } = createHandler();

    handler.handle(request(1));
    expect(respond).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ error: expect.any(Object) }),
    );
    expect(fail).toHaveBeenCalledWith(
      expect.objectContaining({ code: "user-input.unsupported" }),
    );
  });

  it("does not send a fallback after an uncertain success write", async () => {
    const writeFailure = new Error("write outcome unknown");
    const respond = vi.fn(() => {
      throw writeFailure;
    });
    const fail = vi.fn();
    const handler = createCodexUserInputHandler({
      threadId: "thread-1",
      turnId: "turn-1",
      onUserInput: async () => "answer",
      respond,
      fail,
    });

    handler.handle(request(1));
    await Promise.resolve();
    expect(respond).toHaveBeenCalledTimes(1);
    expect(fail).toHaveBeenCalledWith(writeFailure);
  });
});
