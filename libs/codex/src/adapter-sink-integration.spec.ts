// @test-scope ./adapter.ts
// @test-scope ./transport.ts
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentAdapterRequest } from "@seqlane/agent-adapter";
import type { TaskDefinition } from "@seqlane/core";
import { createCodexAdapter } from "./adapter.js";
import { createCodexStdioTransport } from "./transport.js";

const fixture = fileURLToPath(
  new URL("./controlled-codex-app-server.mjs", import.meta.url),
);
const directories: string[] = [];
const adapters: ReturnType<typeof createCodexAdapter>[] = [];
const task: TaskDefinition = {
  id: "codex-live-sink-task",
  input: z.string(),
  output: z.object({ result: z.string() }),
  execute: async () => ({ result: "unused" }),
};

function containsCause(value: unknown, expected: unknown): boolean {
  if (value === expected) return true;
  if (value instanceof AggregateError)
    return [...value.errors].some((cause) => containsCause(cause, expected));
  if (value instanceof Error && Object.hasOwn(value, "cause"))
    return containsCause(value.cause, expected);
  return false;
}

afterEach(async () => {
  await Promise.all(
    adapters
      .splice(0)
      .map((adapter) => adapter.close?.().catch(() => undefined)),
  );
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("Codex live canonical sink failure", () => {
  it("interrupts a real stdio turn and keeps the first cause through terminal sink failure", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "seqlane-codex-sink-"));
    directories.push(cwd);
    const eventFile = join(cwd, "events");
    const primary = Object.freeze(new Error("activity sink failed"));
    const terminal = new Error("terminal activity sink failed");
    let terminalAfterInterrupt = false;
    const adapter = createCodexAdapter(
      {
        executable: process.execPath,
        workspace: cwd,
        networkAccess: false,
      },
      {
        modelSelection: {
          model: { provider: "openai", model: "gpt-5.1-codex" },
          reasoning: "high",
        },
        createTransport: (configuration, transportOptions) =>
          createCodexStdioTransport(configuration, {
            ...transportOptions,
            spawnProcess: (_executable, _args, workingDirectory) =>
              spawn(process.execPath, [fixture], {
                cwd: workingDirectory,
                env: { ...process.env, CODEX_EVENT_FILE: eventFile },
                stdio: ["pipe", "pipe", "pipe"],
              }),
          }),
      },
    );
    adapters.push(adapter);
    const request: AgentAdapterRequest = {
      invocationId: "codex-live-sink-invocation",
      task,
      input: "run a live tool",
      agent: { goal: "run the task" },
      signal: new AbortController().signal,
      onExecutionStarted: () => undefined,
      onActivity: (activity) => {
        if (activity.state === "started") throw primary;
        terminalAfterInterrupt =
          existsSync(eventFile) &&
          readFileSync(eventFile, "utf8").includes("turn-interrupted\n");
        throw terminal;
      },
    };

    const outcome = await adapter.execute(request).then(
      (value) => ({ fulfilled: true as const, value }),
      (cause: unknown) => ({ fulfilled: false as const, cause }),
    );
    expect(outcome.fulfilled).toBe(false);
    if (outcome.fulfilled) throw new Error("Codex unexpectedly succeeded");
    expect(containsCause(outcome.cause, primary)).toBe(true);
    expect(containsCause(outcome.cause, terminal)).toBe(true);
    expect(terminalAfterInterrupt).toBe(true);
    expect(readFileSync(eventFile, "utf8").split("\n").filter(Boolean)).toEqual(
      [
        "turn-start",
        "tool-started",
        "interrupt-request",
        "interrupt-ack",
        "turn-interrupted",
      ],
    );
  });
});
