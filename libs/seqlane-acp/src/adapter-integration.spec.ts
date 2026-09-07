// @test-scope ./adapter.ts
// @test-scope ./stream.ts

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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

function configuration(
  cwd: string,
  mode: string,
  persistSession = false,
  exitFile?: string,
) {
  return {
    id: "controlled-acp",
    description: "Controlled ACP integration fixture",
    command: process.execPath,
    args: [fixture, "configured-argument"],
    env: {
      CONTROLLED_ACP_MODE: mode,
      ...(exitFile === undefined ? {} : { CONTROLLED_ACP_EXIT_FILE: exitFile }),
    },
    cwd,
    persistSession,
    model: "controlled-model",
  };
}

async function waitForExitFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`Controlled ACP process did not exit: ${path}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
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
    const cancellationCwd = mkdtempSync(join(tmpdir(), "seqlane-acp-"));
    const cancellationExitFile = join(cancellationCwd, "exit");
    const cancellation = new AbortController();
    let promptStarted!: () => void;
    const promptStartedPromise = new Promise<void>((resolve) => {
      promptStarted = resolve;
    });
    const cancelled = createAcpAdapter(
      configuration(cancellationCwd, "cancel", false, cancellationExitFile),
    );
    const cancellationExecution = cancelled.execute(
      request(cancellation.signal, {
        onActivity: () => promptStarted(),
      }),
    );
    await promptStartedPromise;
    cancellation.abort(new Error("cancelled by test"));
    await expect(cancellationExecution).rejects.toMatchObject({
      code: "cancellation",
    });
    await waitForExitFile(cancellationExitFile);
    expect(readFileSync(cancellationExitFile, "utf8")).toBe("exit");

    const permissionCwd = mkdtempSync(join(tmpdir(), "seqlane-acp-"));
    const permissionExitFile = join(permissionCwd, "exit");
    const permission = createAcpAdapter(
      configuration(permissionCwd, "permission", false, permissionExitFile),
    );
    await expect(
      permission.execute(request(new AbortController().signal)),
    ).rejects.toMatchObject({
      name: "InteractionRequiredError",
      requirement: "user-input",
    });
    await waitForExitFile(permissionExitFile);
    expect(readFileSync(permissionExitFile, "utf8")).toBe("exit");
  });
});
