// @test-scope ./run.ts
import { z } from "zod";
import type { CodexInboundMessage } from "./protocol.js";
import { describe, expect, it } from "vitest";
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
        createTransport: async () => {
          starts += 1;
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
    await expect(
      run.createAdapter(request.signal).execute(request),
    ).resolves.toEqual({ result: "done" });
    await expect(
      run.createAdapter(request.signal).execute({
        ...request,
        invocationId: "invocation-2",
      }),
    ).resolves.toEqual({ result: "done" });
    expect(starts).toBe(1);
    expect(threads).toBe(2);
    expect(closes).toBe(0);
    await run.close();
    await run.close();
    expect(closes).toBe(1);
  });
});
