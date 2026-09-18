// @test-scope ./run.ts
import { z } from "zod";
import type { CodexInboundMessage } from "./protocol.js";
import { describe, expect, it, vi } from "vitest";
import { createCodexRun } from "./run.js";
import type { CodexTransport } from "./transport.js";

interface RunTransportTurnContext {
  readonly threadId: string;
  readonly turnId: string;
  readonly turnNumber: number;
  readonly emit: (message: CodexInboundMessage) => void;
}

interface RunTransportOptions {
  readonly onThreadStart?: (threadId: string) => void;
  readonly onTurnStart?: (context: RunTransportTurnContext) => void;
  readonly onInterrupt?: (context: RunTransportTurnContext) => void;
  readonly onClose?: () => void;
}

function createRunTestTransport(
  options: RunTransportOptions = {},
): CodexTransport {
  let closed = false;
  let threadNumber = 0;
  let turnNumber = 0;
  const listeners = new Set<(message: CodexInboundMessage) => void>();
  const emit = (message: CodexInboundMessage): void => {
    for (const listener of listeners) listener(message);
  };

  return {
    termination: Promise.resolve(),
    request: async (method, params) => {
      if (closed) throw new Error("transport is closed");
      if (method === "model/list") {
        return {
          data: [
            {
              id: "openai/gpt-5.6-sol",
              model: "gpt-5.6-sol",
              isDefault: true,
            },
          ],
        };
      }
      if (method === "thread/start") {
        threadNumber += 1;
        const threadId = `thread-${threadNumber}`;
        options.onThreadStart?.(threadId);
        return { thread: { id: threadId } };
      }
      if (method === "turn/start") {
        turnNumber += 1;
        const threadId = (params as { threadId: string }).threadId;
        const turnId = `turn-${turnNumber}`;
        options.onTurnStart?.({
          threadId,
          turnId,
          turnNumber,
          emit,
        });
        return { turn: { id: turnId, status: "inProgress", items: [] } };
      }
      if (method === "turn/interrupt") {
        const threadId = (params as { threadId: string }).threadId;
        const turnId = (params as { turnId: string }).turnId;
        options.onInterrupt?.({
          threadId,
          turnId,
          turnNumber,
          emit,
        });
        return {};
      }
      if (method === "thread/fork") {
        return { thread: { id: `thread-fork-${threadNumber + 1}` } };
      }
      throw new Error(`Unexpected method ${method}`);
    },
    respond: () => undefined,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: async () => {
      closed = true;
      options.onClose?.();
    },
  };
}

describe("Codex run ownership", () => {
  it("shares one app-server across model preflight and sessions, then closes it once", async () => {
    let starts = 0;
    let closes = 0;
    let threads = 0;
    const transport = createRunTestTransport({
      onThreadStart: () => {
        threads += 1;
      },
      onTurnStart: ({ threadId, turnId, emit }) => {
        setTimeout(() => {
          emit({
            kind: "notification",
            notification: {
              method: "item/completed",
              params: {
                threadId,
                turnId,
                item: {
                  id: `message-${threadId}`,
                  type: "agentMessage",
                  text: '{"result":"done"}',
                },
              },
            },
          });
          emit({
            kind: "notification",
            notification: {
              method: "turn/completed",
              params: {
                threadId,
                turn: { id: turnId, status: "completed", items: [] },
              },
            },
          });
        }, 0);
      },
      onClose: () => {
        closes += 1;
      },
    });
    const run = createCodexRun(
      {
        executable: "/opt/codex",
        workspace: "/workspace",
        networkAccess: false,
      },
      {
        initialDiagnostics: [
          {
            code: "codex.executable.configured-path-unavailable",
            message:
              "Configured Codex executable is unavailable; using Codex found on PATH",
          },
        ],
        createTransport: async (_configuration, options) => {
          starts += 1;
          options.onDiagnostic?.({
            code: "codex-version-unconfirmed",
            message: "Codex version is not confirmed",
          });
          return transport;
        },
      },
    );
    await expect(run.modelCapabilities.resolveDefaultModel()).resolves.toEqual({
      model: { provider: "openai", model: "gpt-5.6-sol" },
    });
    const task = {
      id: "codex-task",
      input: z.object({}),
      output: z.object({ result: z.string() }),
      execute: async () => ({ result: "unused" }),
    };
    const request = {
      invocationId: "invocation-1",
      observability: {},
      task,
      input: {},
      agent: { goal: "Return JSON" },
      signal: new AbortController().signal,
    };
    const diagnostics: string[] = [];
    const firstAdapter = run.createAdapter(request.signal);
    await expect(
      firstAdapter.execute({
        ...request,
        onDiagnostic: ({ message }) => diagnostics.push(message),
      }),
    ).resolves.toEqual({ result: "done" });
    await firstAdapter.close?.();
    await expect(
      run.createAdapter(request.signal).execute({
        ...request,
        invocationId: "invocation-2",
      }),
    ).resolves.toEqual({ result: "done" });
    expect(starts).toBe(1);
    expect(threads).toBe(2);
    expect(diagnostics).toEqual([
      "Configured Codex executable is unavailable; using Codex found on PATH",
      "Codex version is not confirmed",
    ]);
    expect(closes).toBe(0);
    await run.close();
    await run.close();
    expect(closes).toBe(1);
  });

  it("leaves a late model-discovery transport for the run to close once", async () => {
    let closes = 0;
    let resolveTransport!: (transport: CodexTransport) => void;
    const transport = {
      close: async () => {
        closes += 1;
      },
    } as CodexTransport;
    const run = createCodexRun(
      {
        executable: "/opt/codex",
        workspace: "/workspace",
        networkAccess: false,
      },
      {
        createTransport: () =>
          new Promise<CodexTransport>((resolve) => {
            resolveTransport = resolve;
          }),
      },
    );

    vi.useFakeTimers();
    try {
      const lookup = run.modelCapabilities.listModels().then(
        () => undefined,
        (cause) => cause,
      );
      for (
        let index = 0;
        index < 20 && typeof resolveTransport !== "function";
        index += 1
      ) {
        await Promise.resolve();
      }
      expect(resolveTransport).toBeTypeOf("function");
      const closing = run.close();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(closing).resolves.toBeUndefined();
      await expect(lookup).resolves.toMatchObject({ code: "cancellation" });
      expect(closes).toBe(0);
      resolveTransport(transport);
      await Promise.resolve();
      await Promise.resolve();
      expect(closes).toBe(1);
      await run.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the shared transport open after a parallel session timeout", async () => {
    let closes = 0;
    let turnNumber = 0;
    let hangingTurnId: string | undefined;
    const transport = createRunTestTransport({
      onTurnStart: ({ threadId, turnId, turnNumber: currentTurn, emit }) => {
        turnNumber = currentTurn;
        if (hangingTurnId === undefined) {
          hangingTurnId = turnId;
          return;
        }
        setTimeout(() => {
          emit({
            kind: "notification",
            notification: {
              method: "item/completed",
              params: {
                threadId,
                turnId,
                item: {
                  id: `message-${turnId}`,
                  type: "agentMessage",
                  text: '{"result":"done"}',
                },
              },
            },
          });
          emit({
            kind: "notification",
            notification: {
              method: "turn/completed",
              params: {
                threadId,
                turn: { id: turnId, status: "completed", items: [] },
              },
            },
          });
        }, 0);
      },
      onInterrupt: ({ threadId, turnId, emit }) => {
        setTimeout(() => {
          emit({
            kind: "notification",
            notification: {
              method: "turn/completed",
              params: {
                threadId,
                turn: { id: turnId, status: "interrupted", items: [] },
              },
            },
          });
        }, 0);
      },
      onClose: () => {
        closes += 1;
      },
    });
    const run = createCodexRun(
      {
        executable: "/opt/codex",
        workspace: "/workspace",
        networkAccess: false,
      },
      { createTransport: async () => transport },
    );
    const task = {
      id: "codex-task",
      input: z.object({}),
      output: z.object({ result: z.string() }),
      execute: async () => ({ result: "unused" }),
    };
    const request = {
      invocationId: "invocation-1",
      observability: {},
      task,
      input: {},
      agent: { goal: "Return JSON" },
      signal: new AbortController().signal,
    };

    vi.useFakeTimers();
    try {
      const hanging = run
        .createAdapter(request.signal)
        .execute(request)
        .then(
          () => undefined,
          (cause) => cause,
        );
      const successful = run.createAdapter(request.signal).execute({
        ...request,
        invocationId: "invocation-2",
      });
      for (let index = 0; index < 20 && turnNumber < 2; index += 1) {
        await Promise.resolve();
      }
      expect(turnNumber).toBe(2);
      await vi.runAllTimersAsync();
      await expect(successful).resolves.toEqual({ result: "done" });
      await expect(hanging).resolves.toMatchObject({ code: "cancellation" });
      expect(closes).toBe(0);
      await run.close();
      expect(closes).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes the run after failed interruption and rejects sibling and checkpoint reuse", async () => {
    let closes = 0;
    let turnNumber = 0;
    const transport = createRunTestTransport({
      onTurnStart: ({ threadId, turnId, turnNumber: currentTurn, emit }) => {
        turnNumber = currentTurn;
        if (currentTurn !== 1) return;
        setTimeout(() => {
          emit({
            kind: "notification",
            notification: {
              method: "item/completed",
              params: {
                threadId,
                turnId,
                item: {
                  id: "message-1",
                  type: "agentMessage",
                  text: '{"result":"done"}',
                },
              },
            },
          });
          emit({
            kind: "notification",
            notification: {
              method: "turn/completed",
              params: {
                threadId,
                turn: { id: turnId, status: "completed", items: [] },
              },
            },
          });
        }, 0);
      },
      onInterrupt: () => {
        throw new Error("interrupt was refused");
      },
      onClose: () => {
        closes += 1;
      },
    });
    const run = createCodexRun(
      {
        executable: "/opt/codex",
        workspace: "/workspace",
        networkAccess: false,
      },
      { createTransport: async () => transport },
    );
    const task = {
      id: "codex-task",
      input: z.object({}),
      output: z.object({ result: z.string() }),
      execute: async () => ({ result: "unused" }),
    };
    const request = {
      invocationId: "invocation-1",
      observability: {},
      task,
      input: {},
      agent: { goal: "Return JSON" },
      signal: new AbortController().signal,
    };
    const adapter = run.createAdapter(request.signal);
    await expect(adapter.execute(request)).resolves.toEqual({ result: "done" });
    const checkpoint = await adapter.captureCheckpoint!();

    const controller = new AbortController();
    const interrupted = adapter
      .execute({
        ...request,
        invocationId: "invocation-2",
        signal: controller.signal,
      })
      .then(
        () => undefined,
        (cause) => cause,
      );
    const sibling = run.createAdapter(request.signal);
    const siblingWork = sibling
      .execute({
        ...request,
        invocationId: "invocation-3",
      })
      .then(
        () => undefined,
        (cause) => cause,
      );
    for (let index = 0; index < 30 && turnNumber < 3; index += 1) {
      await Promise.resolve();
    }
    expect(turnNumber).toBe(3);
    controller.abort(new Error("cancel second turn"));

    await expect(interrupted).resolves.toMatchObject({ code: "cancellation" });
    await expect(siblingWork).resolves.toBeDefined();
    expect(closes).toBe(1);
    await expect(adapter.captureCheckpoint!()).rejects.toThrow("invalidated");
    await expect(adapter.fork!({ checkpoint })).rejects.toThrow("invalidated");
    await expect(sibling.captureCheckpoint!()).rejects.toThrow("invalidated");
    await run.close();
    expect(closes).toBe(1);
  });
});
