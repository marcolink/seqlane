// @test-scope ./run.ts
import { z } from "zod";
import type { CodexInboundMessage } from "./protocol.js";
import { describe, expect, it, vi } from "vitest";
import { createCodexRun } from "./run.js";
import type { CodexTransport } from "./transport.js";

describe("Codex run ownership", () => {
  it("shares one app-server across model preflight and sessions, then closes it once", async () => {
    let starts = 0;
    let closes = 0;
    let threads = 0;
    const listeners = new Set<(message: CodexInboundMessage) => void>();
    const transport: CodexTransport = {
      termination: Promise.resolve(),
      request: async (method, params) => {
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
          threads += 1;
          return { thread: { id: `thread-${threads}` } };
        }
        if (method === "turn/start") {
          const threadId = (params as { threadId: string }).threadId;
          const turnId = `turn-${threadId}`;
          setTimeout(() => {
            for (const listener of listeners) {
              listener({
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
              listener({
                kind: "notification",
                notification: {
                  method: "turn/completed",
                  params: {
                    threadId,
                    turn: { id: turnId, status: "completed", items: [] },
                  },
                },
              });
            }
          }, 0);
          return { turn: { id: turnId, status: "inProgress", items: [] } };
        }
        throw new Error(`Unexpected method ${method}`);
      },
      respond: () => undefined,
      subscribe: (listener: (message: CodexInboundMessage) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close: async () => {
        closes += 1;
      },
    };
    const run = createCodexRun(
      {
        executable: "/opt/codex",
        workspace: "/workspace",
        networkAccess: false,
      },
      {
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
    expect(diagnostics).toEqual(["Codex version is not confirmed"]);
    expect(closes).toBe(0);
    await run.close();
    await run.close();
    expect(closes).toBe(1);
  });

  it("keeps the shared transport open after a parallel session timeout", async () => {
    let closes = 0;
    let turnNumber = 0;
    let hangingTurnId: string | undefined;
    const listeners = new Set<(message: CodexInboundMessage) => void>();
    const transport: CodexTransport = {
      termination: Promise.resolve(),
      request: async (method, params) => {
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
          return { thread: { id: `thread-${turnNumber + 1}` } };
        }
        if (method === "turn/start") {
          turnNumber += 1;
          const threadId = (params as { threadId: string }).threadId;
          const turnId = `turn-${turnNumber}`;
          if (hangingTurnId === undefined) {
            hangingTurnId = turnId;
          } else {
            setTimeout(() => {
              for (const listener of listeners) {
                listener({
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
                listener({
                  kind: "notification",
                  notification: {
                    method: "turn/completed",
                    params: {
                      threadId,
                      turn: { id: turnId, status: "completed", items: [] },
                    },
                  },
                });
              }
            }, 0);
          }
          return { turn: { id: turnId, status: "inProgress", items: [] } };
        }
        if (method === "turn/interrupt") {
          const threadId = (params as { threadId: string }).threadId;
          const turnId = (params as { turnId: string }).turnId;
          setTimeout(() => {
            for (const listener of listeners) {
              listener({
                kind: "notification",
                notification: {
                  method: "turn/completed",
                  params: {
                    threadId,
                    turn: { id: turnId, status: "interrupted", items: [] },
                  },
                },
              });
            }
          }, 0);
          return {};
        }
        throw new Error(`Unexpected method ${method}`);
      },
      respond: () => undefined,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close: async () => {
        closes += 1;
      },
    };
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
});
