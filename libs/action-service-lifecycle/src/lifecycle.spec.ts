// @test-scope ./lifecycle.ts
// @test-scope ./process-anchor.ts
// @test-scope ./schemas.ts
// @test-scope ./termination.ts
// @test-scope ./process-identity.ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Effect, Exit, Schedule } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import * as processIdentityModule from "./process-identity.js";
import {
  adoptDetachedProcess,
  cleanupDetachedProcess,
  completeDetachedProcessHandoff,
  SpawnDetachedError,
  spawnDetached,
  terminateProcessGroup,
  type DetachedProcess,
  type ProcessIdentity,
} from "./lifecycle.js";
import { waitForProcessGroupExit } from "./process-identity.js";

const anchorPath = resolve(import.meta.dirname, "../dist/process-anchor.js");
const directories: string[] = [];
const adoptedServices: DetachedProcess[] = [];

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "seqlane-lifecycle-"));
  directories.push(directory);
  return directory;
}

function sentinel(service: DetachedProcess) {
  return { pid: service.sentinelPid, identity: service.sentinelIdentity };
}

function spawnProgram(
  directory: string,
  command = process.execPath,
  args = ["-e", "setInterval(() => {}, 60000)"],
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* spawnDetached({
        command,
        args,
        cwd: process.cwd(),
        env: process.env,
        logPath: join(directory, "service.log"),
        anchorPath,
      });
      yield* adoptDetachedProcess(service);
      yield* completeDetachedProcessHandoff(service);
      return service;
    }),
  );
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (cause) {
      const parsed = z
        .object({ code: z.string() })
        .passthrough()
        .safeParse(cause);
      if (parsed.success && parsed.data.code === "ESRCH") return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`Process ${pid} did not exit`);
}

function waitForChildSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    child.once("spawn", () => resolvePromise());
    child.once("error", reject);
  });
}

afterEach(async () => {
  for (const service of adoptedServices.splice(0)) {
    await Effect.runPromise(
      terminateProcessGroup(service.pid, service.identity, sentinel(service)),
    );
  }
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("action service lifecycle", () => {
  it("adopts only after persistence and keeps the service after main scope closes", async () => {
    const directory = await createDirectory();
    const saved: unknown[] = [];
    const service = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const owned = yield* spawnDetached({
            command: process.execPath,
            args: ["-e", "setInterval(() => {}, 60000)"],
            cwd: process.cwd(),
            env: process.env,
            logPath: join(directory, "service.log"),
            anchorPath,
          });
          saved.push({
            pid: owned.pid,
            identity: owned.identity,
            sentinel: sentinel(owned),
          });
          yield* adoptDetachedProcess(owned);
          yield* completeDetachedProcessHandoff(owned);
          return owned;
        }),
      ),
    );
    adoptedServices.push(service);

    expect(saved).toHaveLength(1);
    expect(() => process.kill(service.pid, 0)).not.toThrow();
    expect(service.anchor.connected).toBe(false);
    expect(
      await Effect.runPromise(
        terminateProcessGroup(service.pid, service.identity, sentinel(service)),
      ),
    ).toBe(true);
    await waitForProcessExit(service.pid);
  }, 15_000);

  it("cleans an acquired service when its native scope is interrupted before adoption", async () => {
    const directory = await createDirectory();
    let pid: number | undefined;
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* spawnDetached({
            command: process.execPath,
            args: ["-e", "setInterval(() => {}, 60000)"],
            cwd: process.cwd(),
            env: process.env,
            logPath: join(directory, "service.log"),
            anchorPath,
          });
          pid = service.pid;
          yield* Effect.interrupt;
        }),
      ),
    );

    expect(Exit.hasInterrupts(exit)).toBe(true);
    expect(pid).toBeDefined();
    await waitForProcessExit(pid!);
  }, 15_000);

  it("keeps cleanup authority through adoption until readiness succeeds", async () => {
    const directory = await createDirectory();
    let pid: number | undefined;
    await expect(
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const service = yield* spawnDetached({
              command: process.execPath,
              args: ["-e", "setInterval(() => {}, 60000)"],
              cwd: process.cwd(),
              env: process.env,
              logPath: join(directory, "service.log"),
              anchorPath,
            });
            pid = service.pid;
            yield* adoptDetachedProcess(service);
            return yield* Effect.fail(new Error("readiness failed"));
          }),
        ),
      ),
    ).rejects.toThrow("readiness failed");

    expect(pid).toBeDefined();
    await waitForProcessExit(pid!);
  }, 15_000);

  it("reports partial startup uncertainty and confirms a safe cleanup retry", async () => {
    const directory = await createDirectory();

    const failure = await Effect.runPromise(
      spawnProgram(directory, join(directory, "missing-service"), []),
    ).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(SpawnDetachedError);
    if (!(failure instanceof SpawnDetachedError)) return;
    expect(failure.cleanupSucceeded).toBe(false);
    expect(failure.ownership).toMatchObject({
      pid: expect.any(Number),
      identity: { processGroupId: expect.any(Number) },
      sentinel: {
        pid: expect.any(Number),
        identity: { processGroupId: expect.any(Number) },
      },
    });
    const owner = failure.ownership;
    expect(owner).toBeDefined();
    if (!owner) return;
    expect(
      await Effect.runPromise(
        terminateProcessGroup(owner.pid, owner.identity, owner.sentinel),
      ),
    ).toBe(true);
  }, 15_000);

  it("disconnects the resident when identity capture fails and preserves foreign processes", async () => {
    const directory = await createDirectory();
    const grandchildPidPath = join(directory, "grandchild.pid");
    const grandchildCode = [
      'const { writeFileSync } = require("node:fs");',
      'process.on("SIGTERM", () => {});',
      "setInterval(() => {}, 60000);",
      `writeFileSync(${JSON.stringify(grandchildPidPath)}, String(process.pid));`,
    ].join("\n");
    const serviceCode = [
      'const { spawn } = require("node:child_process");',
      'process.on("SIGTERM", () => {});',
      `spawn(process.execPath, ["-e", ${JSON.stringify(grandchildCode)}], { stdio: "ignore" });`,
      "setInterval(() => {}, 60000);",
    ].join("\n");
    const foreign = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 60000)"],
      { detached: true, stdio: "ignore" },
    );
    try {
      await waitForChildSpawn(foreign);
      let observedAnchorIdentity: ProcessIdentity | undefined;
      const readIdentity = processIdentityModule.readProcessIdentity;
      const identityReader = vi
        .spyOn(processIdentityModule, "readProcessIdentity")
        .mockImplementationOnce((pid) =>
          Effect.gen(function* () {
            const grandchildPid = yield* Effect.tryPromise(async (signal) =>
              z.coerce
                .number()
                .int()
                .positive()
                .parse(
                  await readFile(grandchildPidPath, {
                    encoding: "utf8",
                    signal,
                  }),
                ),
            ).pipe(
              Effect.retry(Schedule.spaced("10 millis")),
              Effect.timeout("5 seconds"),
            );
            observedAnchorIdentity = yield* readIdentity(pid);
            const grandchildIdentity = yield* readIdentity(grandchildPid);
            expect(grandchildIdentity).toBeDefined();
            expect(grandchildIdentity?.processGroupId).toBe(
              observedAnchorIdentity?.processGroupId,
            );
            return undefined;
          }),
        );
      const failure = await Effect.runPromise(
        Effect.scoped(
          spawnDetached({
            command: process.execPath,
            args: ["-e", serviceCode],
            cwd: process.cwd(),
            env: process.env,
            logPath: join(directory, "service.log"),
            anchorPath,
          }).pipe(Effect.catch((cause) => Effect.succeed(cause))),
        ),
      );
      identityReader.mockRestore();
      expect(failure).toBeInstanceOf(SpawnDetachedError);
      if (!(failure instanceof SpawnDetachedError)) return;
      expect(failure.ownership).toBeUndefined();
      expect(failure.cleanupSucceeded, String(failure.cause)).toBe(true);
      expect(observedAnchorIdentity).toBeDefined();
      if (!observedAnchorIdentity) return;
      const grandchildPid = Number(await readFile(grandchildPidPath, "utf8"));
      expect(Number.isInteger(grandchildPid)).toBe(true);
      expect(
        await Effect.runPromise(
          waitForProcessGroupExit(observedAnchorIdentity.processGroupId, 5_000),
        ),
      ).toBe(true);
      const foreignPid = foreign.pid;
      if (!foreignPid) throw new Error("Foreign process did not receive a PID");
      expect(() => process.kill(foreignPid, 0)).not.toThrow();
    } finally {
      vi.restoreAllMocks();
      if (
        foreign.pid &&
        foreign.exitCode === null &&
        foreign.signalCode === null
      )
        foreign.kill("SIGKILL");
    }
  }, 15_000);

  it("rejects unsupported identity platforms before creating a child", async () => {
    const directory = await createDirectory();
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    if (!platform?.configurable) return;
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32",
    });
    try {
      const result = await Effect.runPromiseExit(
        Effect.scoped(
          spawnDetached({
            command: process.execPath,
            args: ["-e", "process.exit(0)"],
            cwd: process.cwd(),
            env: process.env,
            logPath: join(directory, "service.log"),
            anchorPath,
          }),
        ),
      );
      expect(Exit.isFailure(result)).toBe(true);
      await expect(
        readFile(join(directory, "service.log")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("reports explicit cleanup and leaves the finalizer idempotent", async () => {
    const directory = await createDirectory();
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* spawnDetached({
            command: process.execPath,
            args: ["-e", "setInterval(() => {}, 60000)"],
            cwd: process.cwd(),
            env: process.env,
            logPath: join(directory, "service.log"),
            anchorPath,
          });
          const cleanupSucceeded = yield* cleanupDetachedProcess(service);
          return { service, cleanupSucceeded };
        }),
      ),
    );

    expect(result.cleanupSucceeded).toBe(true);
    await waitForProcessExit(result.service.pid);
  }, 15_000);

  it("keeps the scope finalizer when a cleanup effect is constructed but unused", async () => {
    const directory = await createDirectory();
    const service = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const owned = yield* spawnDetached({
            command: process.execPath,
            args: ["-e", "setInterval(() => {}, 60000)"],
            cwd: process.cwd(),
            env: process.env,
            logPath: join(directory, "service.log"),
            anchorPath,
          });
          const unusedCleanup = cleanupDetachedProcess(owned);
          expect(unusedCleanup).toBeDefined();
          return owned;
        }),
      ),
    );

    await waitForProcessExit(service.pid);
  }, 15_000);

  it("refuses cleanup when both saved process identities are malformed or reused", async () => {
    const directory = await createDirectory();
    const service = await Effect.runPromise(spawnProgram(directory));
    adoptedServices.push(service);

    expect(
      await Effect.runPromise(terminateProcessGroup("bad-pid", {}, {})),
    ).toBe(false);
    expect(
      await Effect.runPromise(
        terminateProcessGroup(
          service.pid,
          {
            processGroupId: service.identity.processGroupId,
            processStartTime: "reused-pid",
          },
          {
            pid: service.sentinelPid,
            identity: {
              ...service.sentinelIdentity,
              processStartTime: "reused-sentinel",
            },
          },
        ),
      ),
    ).toBe(false);
    expect(() =>
      process.kill(-service.identity.processGroupId, 0),
    ).not.toThrow();
  }, 15_000);

  it("terminates a service from its verified sentinel when the leader has exited", async () => {
    const directory = await createDirectory();
    const service = await Effect.runPromise(spawnProgram(directory));
    adoptedServices.push(service);
    process.kill(service.pid, "SIGKILL");
    await waitForProcessExit(service.pid);

    expect(
      await Effect.runPromise(
        terminateProcessGroup(service.pid, service.identity, sentinel(service)),
      ),
    ).toBe(true);
  }, 15_000);

  it("kills a TERM-resistant grandchild after the owned grace period", async () => {
    const directory = await createDirectory();
    const grandchildPidPath = join(directory, "grandchild.pid");
    const serviceCode = [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      'const child = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 60000)"] , { stdio: "ignore" });',
      `writeFileSync(${JSON.stringify(grandchildPidPath)}, String(child.pid));`,
      'process.on("SIGTERM", () => {});',
      "setInterval(() => {}, 60000);",
    ].join("\n");
    const service = await Effect.runPromise(
      spawnProgram(directory, process.execPath, ["-e", serviceCode]),
    );
    adoptedServices.push(service);

    let pidText: string | undefined;
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && pidText === undefined) {
      pidText = await readFile(grandchildPidPath, "utf8").catch(
        () => undefined,
      );
      if (pidText === undefined)
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    if (pidText === undefined) {
      throw new Error(
        `Grandchild did not start: ${await readFile(join(directory, "service.log"), "utf8").catch(() => "no service log")}`,
      );
    }
    const grandchildPid = Number(pidText);
    expect(Number.isInteger(grandchildPid)).toBe(true);
    expect(
      await Effect.runPromise(
        terminateProcessGroup(service.pid, service.identity, sentinel(service)),
      ),
    ).toBe(true);
    await waitForProcessExit(grandchildPid);
  }, 20_000);
});
