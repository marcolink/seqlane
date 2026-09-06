// @test-scope ./adapter.ts
// @test-scope ./stream.ts

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAcpAdapter } from "./adapter.js";
import type { AgentAdapterRequest } from "@seqlane/agent-adapter";
import type { AgentTaskDefinition } from "@seqlane/core";

const fixture = fileURLToPath(
  new URL("./controlled-acp-agent.mjs", import.meta.url),
);
const resultSchema = z.object({
  value: z.string(),
  cwd: z.string(),
  model: z.string(),
  argument: z.string(),
  promptCount: z.number(),
});
const task: AgentTaskDefinition = {
  id: "controlled-acp-task",
  input: z.string(),
  output: resultSchema,
  goal: (input) => String(input),
};

function configuration(cwd: string, mode: string, persistSession = false) {
  return {
    id: "controlled-acp",
    description: "Controlled ACP integration fixture",
    command: process.execPath,
    args: [fixture, "configured-argument"],
    env: { CONTROLLED_ACP_MODE: mode },
    cwd,
    persistSession,
    model: "controlled-model",
  };
}

function request(
  signal: AbortSignal,
  overrides: Partial<AgentAdapterRequest> = {},
): AgentAdapterRequest {
  return {
    invocationId: "controlled-acp-invocation",
    task,
    input: "controlled input",
    signal,
    ...overrides,
  };
}

describe("Mastra ACP adapter boundary", () => {
  it("launches the configured ACP process and maps workspace, model, output, and activity", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "seqlane-acp-"));
    const activities: unknown[] = [];
    const adapter = createAcpAdapter(configuration(cwd, "success"));

    await expect(
      adapter.execute(
        request(new AbortController().signal, {
          onActivity: (activity) => activities.push(activity),
        }),
      ),
    ).resolves.toEqual({
      value: "done",
      cwd,
      model: "controlled-model",
      argument: "configured-argument",
      promptCount: 1,
    });
    expect(activities).toEqual([
      {
        activityId: "controlled-tool",
        kind: "tool",
        name: "read_file",
        state: "started",
        input: { path: "AGENTS.md" },
      },
      {
        activityId: "controlled-tool",
        kind: "tool",
        name: "read_file",
        state: "succeeded",
        output: "ok",
      },
    ]);
    expect(adapter.capabilities).toMatchObject({
      execute: true,
      modelSelection: false,
      structuredOutput: true,
      activity: true,
      sessionReuse: false,
      checkpoint: false,
      fork: false,
    });
  });

  it("reuses one configured ACP session when persistence is enabled", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "seqlane-acp-"));
    const adapter = createAcpAdapter(configuration(cwd, "reuse", true));

    await expect(
      adapter.execute(request(new AbortController().signal)),
    ).resolves.toMatchObject({
      promptCount: 1,
    });
    await expect(
      adapter.execute(request(new AbortController().signal)),
    ).resolves.toMatchObject({
      promptCount: 2,
    });
    expect(adapter.capabilities.sessionReuse).toBe(true);
  });

  it("normalizes cancellation and unresolved permission at the ACP boundary", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "seqlane-acp-"));
    const cancellation = new AbortController();
    const cancelled = createAcpAdapter(configuration(cwd, "cancel"), {
      createAgent: () => ({
        stream: async () => {
          throw new Error("controlled abort");
        },
      }),
    });
    cancellation.abort(new Error("cancelled by test"));
    await expect(
      cancelled.execute(request(cancellation.signal)),
    ).rejects.toMatchObject({ code: "cancellation" });

    const permission = createAcpAdapter(configuration(cwd, "permission"), {
      createAgent: (options) => ({
        stream: async () => {
          await options.onPermissionRequest?.({
            tool: "controlled-tool",
          });
          return {
            fullStream: new ReadableStream<unknown>(),
            text: new Promise<string>(() => undefined),
          };
        },
      }),
    });
    await expect(
      permission.execute(request(new AbortController().signal)),
    ).rejects.toMatchObject({
      name: "InteractionRequiredError",
      requirement: "user-input",
    });
  });
});
