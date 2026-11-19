// @test-scope ./command-process.ts
// @test-scope ./git-process.ts
// @test-scope ./docker-cli.ts
// @test-scope ../../adapter/src/private/owned-process/child-lifecycle.ts
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as ownership from "@seqlane/agent-adapter/private/owned-process";
import { runGitCommand } from "./git-process.js";
import { dockerCliEffect, type DockerOwnershipState } from "./docker-cli.js";

afterEach(() => vi.restoreAllMocks());
const run = (code: string, signal?: AbortSignal) =>
  runGitCommand({
    executable: process.execPath,
    args: ["-e", code],
    cwd: process.cwd(),
    ...(signal ? { signal } : {}),
  });

describe("scoped process streams", () => {
  it("keeps argv, cwd, environment, both byte streams and a nonzero exit", async () => {
    const result = await runGitCommand({
      executable: process.execPath,
      args: [
        "-e",
        "process.stdout.write(process.argv[1] + ':' + process.env.SEQLANE_COMMAND_FIXTURE); process.stderr.write(process.cwd()); process.exitCode=7;",
        "literal;$(echo wrong)",
      ],
      cwd: process.cwd(),
      env: { SEQLANE_COMMAND_FIXTURE: "ok" },
    });
    expect(result).toMatchObject({
      exitCode: 7,
      stdout: "literal;$(echo wrong):ok",
      stderr: process.cwd(),
    });
  });

  it("counts bytes and retains bounded partial output on overflow", async () => {
    const result = await run(
      "process.stdout.write('€'.repeat(3_000_000)); setInterval(()=>{},1000)",
    );
    expect(result.exitCode).toBe(1);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(
      8 * 1024 * 1024,
    );
  });

  it("joins identity capture before cancellation releases ownership", async () => {
    const controller = new AbortController();
    const capture = ownership.captureOwnedProcessIdentity;
    let identity: ownership.OwnedProcessIdentity | undefined;
    vi.spyOn(ownership, "captureOwnedProcessIdentity").mockImplementation(
      async (pid) => {
        controller.abort();
        identity = await capture(pid);
        return identity;
      },
    );
    expect(
      await run("setInterval(()=>{},1000)", controller.signal),
    ).toMatchObject({ exitCode: 1 });
    expect(identity).toBeDefined();
    if (identity)
      expect(await ownership.confirmOwnedProcessStopped(identity)).toBe(true);
  });

  it("does not group-signal an unknown identity when its leader exits nonzero", async () => {
    const directory = await mkdtemp(join(tmpdir(), "seqlane-unknown-group-"));
    const ready = join(directory, "ready");
    const foreign = spawn(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      { stdio: "ignore" },
    );
    const code = `const {spawn}=require('node:child_process');
      process.on('SIGTERM',()=>process.exit(7));
      spawn(process.execPath,['-e',${JSON.stringify(`const {writeFileSync}=require('node:fs'); process.on('SIGTERM',()=>{}); writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(()=>{},1000);`)}],{stdio:'ignore'});
      setInterval(()=>{},1000);`;
    let groupPid: number | undefined;
    vi.spyOn(ownership, "captureOwnedProcessIdentity").mockImplementation(
      async (pid) => {
        groupPid = pid;
        await expect.poll(() => existsSync(ready)).toBe(true);
        throw new Error("identity unavailable");
      },
    );
    const terminate = vi.spyOn(ownership, "terminateOwnedProcess");
    try {
      await expect(run(code)).rejects.toThrow("no verified identity");
      expect(groupPid).toBeDefined();
      expect(await ownership.confirmOwnedProcessGroupStopped(groupPid!)).toBe(
        false,
      );
      const descendant = Number(await readFile(ready, "utf8"));
      expect(() => process.kill(descendant, 0)).not.toThrow();
      expect(() => process.kill(foreign.pid!, 0)).not.toThrow();
      expect(terminate).not.toHaveBeenCalled();
    } finally {
      if (existsSync(ready)) {
        const descendant = Number(await readFile(ready, "utf8"));
        process.kill(descendant, "SIGKILL");
      }
      const exited = new Promise<void>((resolve) =>
        foreign.once("exit", () => resolve()),
      );
      foreign.kill("SIGKILL");
      await exited;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("bounds the real Docker client deadline and confirms cleanup", async () => {
    const state: DockerOwnershipState = {};
    await expect(
      Effect.runPromise(
        dockerCliEffect(
          {
            executable: process.execPath,
            args: [
              "-e",
              "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)",
            ],
            cwd: process.cwd(),
            env: {},
            timeoutMs: 100,
          },
          state,
        ),
      ),
    ).rejects.toBeDefined();
    expect(state.uncertainty).toBeUndefined();
  });
});
