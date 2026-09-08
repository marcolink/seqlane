// @test-scope ./post.ts
// @test-scope ./release.ts

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = new Map<string, string>();
const terminate = vi.fn(async () => true);
const warnings: string[] = [];
const temporaryDirectories: string[] = [];
const originalRunnerTemp = process.env.RUNNER_TEMP;

vi.mock("@actions/core", () => ({
  getState: (name: string) => state.get(name) ?? "",
  warning: (message: string) => warnings.push(message),
}));
vi.mock("@seqlane/action-service-lifecycle", () => ({
  terminateProcessGroup: terminate,
}));

const { run } = await import("./post.js");

afterEach(async () => {
  state.clear();
  terminate.mockReset();
  terminate.mockResolvedValue(true);
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
    state.set("pid", "42");
    state.set("process-group-id", "42");
    state.set("process-start-time", "start");
    state.set("sentinel-pid", "41");
    state.set("sentinel-process-group-id", "42");
    state.set("sentinel-process-start-time", "start");
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
    state.set("pid", "42");
    state.set("install-directory", installDirectory);
    terminate.mockResolvedValue(false);

    await run();

    await expect(
      import("node:fs/promises").then(({ stat }) => stat(installDirectory)),
    ).resolves.toBeDefined();
    expect(warnings.join(" ")).toContain("did not stop cleanly");
  });
});
