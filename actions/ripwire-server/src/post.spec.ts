// @test-scope ./post.ts
// @test-scope ./release.ts
// @test-scope ./state.ts

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import {
  CLEANUP_ONLY_STATE_KEY,
  serializeCleanupOnlyState,
  serializeServiceState,
} from "./state.js";

const { state, terminate, terminated, warnings } = vi.hoisted(() => ({
  state: new Map<string, string>(),
  terminated: { value: true },
  terminate: vi.fn(
    (_pid?: unknown, ..._ownership: unknown[]) => terminated.value,
  ),
  warnings: [] as string[],
}));
const temporaryDirectories: string[] = [];
const originalRunnerTemp = process.env.RUNNER_TEMP;

vi.mock("@actions/core", () => ({
  getState: (name: string) => state.get(name) ?? "",
  info: vi.fn(),
  warning: (message: string) => warnings.push(message),
}));
vi.mock("@seqlane/action-service-lifecycle", async () => {
  const actual = await vi.importActual<
    typeof import("@seqlane/action-service-lifecycle")
  >("@seqlane/action-service-lifecycle");
  return {
    ...actual,
    terminateProcessGroup: vi.fn((...args) =>
      Effect.succeed(terminate(...args)),
    ),
  };
});

const { run } = await import("./post.js");

afterEach(async () => {
  state.clear();
  terminate.mockReset();
  terminated.value = true;
  warnings.length = 0;
  if (originalRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
  else process.env.RUNNER_TEMP = originalRunnerTemp;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Ripwire post cleanup", () => {
  it("removes the install directory after successful process termination", async () => {
    const runnerTemp = await mkdtemp(join(tmpdir(), "ripwire-post-test-"));
    temporaryDirectories.push(runnerTemp);
    const installDirectory = join(runnerTemp, "ripwire-install");
    await mkdir(installDirectory);
    await writeFile(join(installDirectory, "ripwire"), "binary");
    process.env.RUNNER_TEMP = runnerTemp;
    state.set(
      "service-state",
      serializeServiceState({
        pid: 42,
        identity: { processGroupId: 42, processStartTime: "start" },
        sentinel: {
          pid: 41,
          identity: { processGroupId: 42, processStartTime: "start" },
        },
      }),
    );
    state.set("install-directory", installDirectory);

    await run();

    expect(terminate).toHaveBeenCalledOnce();
    await expect(
      import("node:fs/promises").then(({ stat }) => stat(installDirectory)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains the install directory when process termination is unverified", async () => {
    const runnerTemp = await mkdtemp(join(tmpdir(), "ripwire-post-test-"));
    temporaryDirectories.push(runnerTemp);
    const installDirectory = join(runnerTemp, "ripwire-install");
    await mkdir(installDirectory);
    process.env.RUNNER_TEMP = runnerTemp;
    state.set(
      "service-state",
      serializeServiceState({
        pid: 42,
        identity: { processGroupId: 42, processStartTime: "start" },
        sentinel: {
          pid: 41,
          identity: { processGroupId: 42, processStartTime: "start" },
        },
      }),
    );
    state.set("install-directory", installDirectory);
    terminated.value = false;

    await run();

    await expect(
      import("node:fs/promises").then(({ stat }) => stat(installDirectory)),
    ).resolves.toBeDefined();
    expect(warnings.join(" ")).toContain("did not stop cleanly");
  });

  it("retains the install directory when service state is invalid", async () => {
    const runnerTemp = await mkdtemp(join(tmpdir(), "ripwire-post-test-"));
    temporaryDirectories.push(runnerTemp);
    const installDirectory = join(runnerTemp, "ripwire-install");
    await mkdir(installDirectory);
    process.env.RUNNER_TEMP = runnerTemp;
    state.set("service-state", "not-json");
    state.set("install-directory", installDirectory);

    await run();

    await expect(
      import("node:fs/promises").then(({ stat }) => stat(installDirectory)),
    ).resolves.toBeDefined();
    expect(terminate).not.toHaveBeenCalled();
    expect(warnings.join(" ")).toContain("missing or invalid");
  });

  it("removes a cleanup-only install without service state", async () => {
    const runnerTemp = await mkdtemp(join(tmpdir(), "ripwire-post-test-"));
    temporaryDirectories.push(runnerTemp);
    const installDirectory = join(runnerTemp, "ripwire-install");
    await mkdir(installDirectory);
    process.env.RUNNER_TEMP = runnerTemp;
    state.set("install-directory", installDirectory);
    state.set(CLEANUP_ONLY_STATE_KEY, serializeCleanupOnlyState());

    await run();

    await expect(
      import("node:fs/promises").then(({ stat }) => stat(installDirectory)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(terminate).not.toHaveBeenCalled();
  });
});
