// @test-scope ./runner-client.ts
// @test-scope ./test-fixtures/runner-supervision-worker.ts

import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { RunRequest, SeqlaneExecutionEvent } from "@seqlane/protocol";
import { launchRunner, type RunnerSignalSource } from "./runner-client.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const cliRoot = join(repositoryRoot, "apps/cli");
const fixture = join(
  cliRoot,
  "dist/test-fixtures/runner-supervision-worker.js",
);
const temporaryRoot = mkdtempSync(
  join(tmpdir(), "seqlane-runner-supervision-"),
);
const markerSchema = z.object({
  ownedPid: z.number().int().positive(),
  foreignPid: z.number().int().positive(),
});

const request: RunRequest = {
  type: "run.start",
  workflow: {
    id: "supervision-fixture",
    moduleSpecifier: "@seqlane/fixtures/renovate-workflow",
    exportName: "renovateWorkflow",
  },
  input: {
    dependency: "demo",
    fromVersion: "1.0.0",
    toVersion: "2.0.0",
    failure: "test",
  },
  runtime: { id: "supervision-test" },
};

function signalSource(emitter: EventEmitter): RunnerSignalSource {
  return {
    on(signal, listener) {
      emitter.on(signal, listener);
      return this;
    },
    removeListener(signal, listener) {
      emitter.removeListener(signal, listener);
      return this;
    },
  };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

async function waitForMarker(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for supervisor fixture marker");
}

async function waitForProcessState(
  pid: number,
  expectedAlive: boolean,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (processAlive(pid) === expectedAlive) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Process ${pid} did not reach expected state`);
}

function start(
  mode: string,
  extra: Record<string, string> = {},
  onExecutionEvent?: (event: SeqlaneExecutionEvent) => void,
) {
  return launchRunner(request, {
    runnerPath: fixture,
    cwd: repositoryRoot,
    environment: {
      ...process.env,
      RUNNER_SUPERVISION_MARKER: join(temporaryRoot, `${mode}.json`),
      RUNNER_SUPERVISION_MODE: mode,
      ...extra,
    },
    gracePeriodMs: 100,
    closeGracePeriodMs: 100,
    onExecutionEvent,
  });
}

afterAll(() => {
  rmSync(temporaryRoot, { recursive: true, force: true });
});

describe("runner supervisor real-process cleanup", () => {
  it("kills an acknowledged detached tree and preserves an unregistered process", async () => {
    const marker = join(temporaryRoot, "owned-tree.json");
    const client = start("owned-tree", { RUNNER_SUPERVISION_MARKER: marker });
    await waitForMarker(marker);
    await waitForMarker(`${marker}.registered`);
    const { ownedPid, foreignPid } = markerSchema.parse(
      JSON.parse(readFileSync(marker, "utf8")),
    );

    try {
      client.cancel();
      await expect(client.result).resolves.toMatchObject({ status: 130 });
      await waitForProcessState(ownedPid, false);
      await waitForProcessState(foreignPid, true);
    } finally {
      try {
        process.kill(-foreignPid, "SIGKILL");
      } catch {
        // The sentinel can already have exited during a failed assertion.
      }
    }
  });

  it.each(["malformed-ipc", "sink-failure", "disconnect"] as const)(
    "bounds cleanup after %s",
    async (mode) => {
      const sinkFailure = new Error("sink failed");
      const client = start(
        mode,
        {},
        mode === "sink-failure"
          ? () => {
              throw sinkFailure;
            }
          : undefined,
      );
      const result = await client.result;
      expect(result.status).toBe(1);
      if (!("failure" in result)) throw new Error("Expected runner failure");
      if (mode === "sink-failure") {
        expect(result.failure.cause).toBe(sinkFailure);
      }
    },
  );

  it("uses one cancellation request and forces cleanup on a repeated signal", async () => {
    const emitter = new EventEmitter();
    const client = launchRunner(request, {
      runnerPath: fixture,
      cwd: repositoryRoot,
      signalSource: signalSource(emitter),
      gracePeriodMs: 5_000,
      closeGracePeriodMs: 100,
    });
    client.cancel();
    emitter.emit("SIGINT");
    await expect(client.result).resolves.toMatchObject({ status: 130 });
  });

  it("does not extend the cleanup deadline while IPC traffic continues", async () => {
    const client = start("noise");
    const startedAt = Date.now();
    client.cancel();
    await expect(client.result).resolves.toMatchObject({ status: 130 });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("waits for forced worker close after terminal timeout despite noisy IPC", async () => {
    const client = start("terminal-noise");
    const startedAt = Date.now();
    await expect(client.result).resolves.toMatchObject({ status: 1 });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  }, 2_500);

  it("reports startup failure after observing worker close", async () => {
    const client = start("startup-failure");
    await expect(client.result).resolves.toMatchObject({ status: 1 });
  });
});
