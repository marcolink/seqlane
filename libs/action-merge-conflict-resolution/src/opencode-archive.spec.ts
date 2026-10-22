// @test-scope ./opencode-archive.ts
// @test-scope ./opencode-process.ts

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import * as processOwnership from "@seqlane/agent-adapter/private/owned-process";
import { extractOpenCodeArchive } from "./opencode-archive.js";
import type { OpenCodeProcessState } from "./opencode-process.js";

const execFileAsync = promisify(execFile);

async function waitForFile(path: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      while (true) {
        const text = yield* Effect.tryPromise(() =>
          readFile(path, "utf8"),
        ).pipe(Effect.catch(() => Effect.succeed(undefined)));
        if (text !== undefined) return text;
        yield* Effect.sleep(10);
      }
    }).pipe(Effect.timeout("5 seconds")),
  );
}

describe("OpenCode archive ownership", () => {
  it("extracts a real archive and joins its native process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "seqlane-archive-"));
    const source = join(directory, "source");
    const target = join(directory, "target");
    const archive = join(directory, "archive.tar.gz");
    await mkdir(source);
    await mkdir(target);
    await writeFile(join(source, "opencode"), "fixture executable");
    await execFileAsync("tar", ["-czf", archive, "-C", source, "opencode"]);
    const state: OpenCodeProcessState = { safeToDelete: true };
    try {
      await Effect.runPromise(extractOpenCodeArchive(archive, target, state));
      expect(await readFile(join(target, "opencode"), "utf8")).toBe(
        "fixture executable",
      );
      expect(state.safeToDelete).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("joins a TERM-resistant extractor and descendant before deleting files on cancellation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "seqlane-archive-cancel-"));
    const readyPath = join(directory, "ready");
    const latePath = join(directory, "late-write");
    const descendant = [
      'const { mkdirSync, writeFileSync } = require("node:fs");',
      'process.on("SIGTERM", () => {});',
      `writeFileSync(${JSON.stringify(readyPath)}, String(process.pid));`,
      `setTimeout(() => { mkdirSync(${JSON.stringify(directory)}, { recursive: true }); writeFileSync(${JSON.stringify(latePath)}, "late"); }, 4000);`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const extractor = [
      'const { spawn } = require("node:child_process");',
      'process.on("SIGTERM", () => {});',
      `spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" });`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const state: OpenCodeProcessState = { safeToDelete: true };
    const controller = new AbortController();
    const running = Effect.runPromise(
      extractOpenCodeArchive("unused", directory, state, {
        executable: process.execPath,
        args: ["-e", extractor],
      }),
      { signal: controller.signal },
    );
    const settled = running.then(
      () => undefined,
      (cause: unknown) => cause,
    );
    try {
      const descendantPid = Number(await waitForFile(readyPath));
      controller.abort(new Error("cancel extraction"));
      expect(await settled).toBeDefined();
      expect(state.safeToDelete).toBe(true);
      expect(() => process.kill(descendantPid, 0)).toThrow();
      await rm(directory, { recursive: true, force: true });
      await Effect.runPromise(Effect.sleep("4200 millis"));
      await expect(readFile(latePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      controller.abort();
      await settled;
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("retains files when a child closes but its unverified group remains active", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "seqlane-archive-uncertain-"),
    );
    const readyPath = join(directory, "ready");
    const capture = vi
      .spyOn(processOwnership, "captureOwnedProcessIdentity")
      .mockImplementationOnce(async () => {
        await waitForFile(readyPath);
        throw new Error("identity unavailable");
      });
    const descendant = [
      'const { writeFileSync } = require("node:fs");',
      'process.on("SIGTERM", () => {});',
      `writeFileSync(${JSON.stringify(readyPath)}, String(process.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const extractor = [
      'const { spawn } = require("node:child_process");',
      `spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" });`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const state: OpenCodeProcessState = { safeToDelete: true };
    try {
      await expect(
        Effect.runPromise(
          extractOpenCodeArchive("unused", directory, state, {
            executable: process.execPath,
            args: ["-e", extractor],
          }),
        ),
      ).rejects.toThrow("identity unavailable");
      expect(state.safeToDelete).toBe(false);
      expect(state.cleanupFailurePresent).toBe(true);
      expect(state.cleanupFailure).toBeInstanceOf(Error);
      expect(await readFile(readyPath, "utf8")).toMatch(/^\d+$/);
    } finally {
      capture.mockRestore();
      // The fixture records the only surviving descendant so test cleanup can stop it.
      const pid = Number(await readFile(readyPath, "utf8"));
      process.kill(pid, "SIGKILL");
      await rm(directory, { recursive: true, force: true });
    }
  });
});
