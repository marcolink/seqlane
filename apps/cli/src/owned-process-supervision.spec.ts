// @test-scope ./owned-process-supervision.ts

import { spawn } from "node:child_process";
import { once } from "node:events";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, describe, expect, it } from "vitest";
import type {
  OwnedProcessFrame,
  OwnedProcessIdentity,
} from "@seqlane/protocol/private/owned-process";
import { captureOwnedProcessIdentity } from "@seqlane/runtime/private/owned-process";
import { createOwnedProcessSupervision } from "./owned-process-supervision.js";

const children: number[] = [];

const fakeIdentity = (pid: number): OwnedProcessIdentity => ({
  version: 1,
  pid,
  processGroupId: pid,
  platform: "linux",
  birthIdentity: `test-${pid}`,
});

const frame = (
  id: string,
  identity: OwnedProcessIdentity,
  action: OwnedProcessFrame["action"] = "register",
): OwnedProcessFrame => ({
  type: "runner.owned-process",
  action,
  id,
  identity,
});

const acknowledgingHost = {
  send(_message: string, callback?: (error: Error | null) => void) {
    callback?.(null);
    return true;
  },
};

const inertOs = {
  isCurrent: async () => true,
  confirmStopped: async () => true,
  terminate: async () => ({ confirmed: true }),
};

afterEach(() => {
  for (const pid of children.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Cleanup may already have stopped the process group.
    }
  }
});

describe("owned process supervision", () => {
  it.skipIf(process.platform === "win32")(
    "acknowledges a process that exits during registration only after its group stops",
    async () => {
      const child = spawn(
        process.execPath,
        [
          "-e",
          "process.stdin.resume(); process.stdin.once('end', () => process.exit(0))",
        ],
        { detached: true, stdio: ["pipe", "ignore", "ignore"] },
      );
      const foreign = spawn(
        process.execPath,
        ["-e", "setInterval(() => undefined, 1000)"],
        { detached: true, stdio: "ignore" },
      );
      if (child.pid === undefined || foreign.pid === undefined) {
        throw new Error("Worker did not start");
      }
      children.push(child.pid, foreign.pid);
      foreign.unref();
      const identity = await captureOwnedProcessIdentity(child.pid);
      const closed = once(child, "close");
      child.stdin.end();
      expect(await closed).toEqual([0, null]);

      let acknowledge: (() => void) | undefined;
      let sent: (() => void) | undefined;
      const ackSent = new Promise<void>((resolve) => {
        sent = resolve;
      });
      const supervision = createOwnedProcessSupervision(
        {
          send(_message, callback) {
            acknowledge = () => callback?.(null);
            sent?.();
            return true;
          },
        },
        () => undefined,
      );
      const registered = Effect.runPromiseExit(
        supervision.handle(frame("short-process", identity)),
      );
      expect(
        await Promise.race([
          ackSent.then(() => "ack"),
          registered.then(() => "settled"),
        ]),
      ).toBe("ack");
      expect(supervision.size).toBe(1);
      acknowledge?.();
      expect((await registered)._tag).toBe("Success");
      await expect(Effect.runPromise(supervision.cleanup())).resolves.toBe(
        true,
      );
      expect(supervision.size).toBe(0);
      expect(() => process.kill(foreign.pid!, 0)).not.toThrow();
    },
  );

  it("rejects a stale identity while its process group may still be active", async () => {
    const supervision = createOwnedProcessSupervision(
      acknowledgingHost,
      () => undefined,
      {
        ...inertOs,
        isCurrent: async () => false,
        confirmStopped: async () => false,
      },
    );
    const result = await Effect.runPromiseExit(
      supervision.handle(frame("stale-active", fakeIdentity(40))),
    );

    expect(result._tag).toBe("Failure");
    expect(supervision.size).toBe(0);
  });

  it("accepts the shared 1,000-attempt budget plus bounded startup headroom", async () => {
    const supervision = createOwnedProcessSupervision(
      acknowledgingHost,
      () => undefined,
      inertOs,
    );

    for (let index = 1; index <= 1_024; index += 1) {
      await Effect.runPromise(
        supervision.handle(frame(`lease-${index}`, fakeIdentity(index))),
      );
    }

    expect(supervision.size).toBe(1_024);
    const rejected = await Effect.runPromiseExit(
      supervision.handle(frame("over-limit", fakeIdentity(1_025))),
    );
    expect(rejected._tag).toBe("Failure");
    expect(supervision.size).toBe(1_024);
  });

  it("preserves rejected OS identity probe causes, including null and undefined", async () => {
    for (const cause of [null, undefined]) {
      const supervision = createOwnedProcessSupervision(
        acknowledgingHost,
        () => undefined,
        {
          ...inertOs,
          isCurrent: () => Promise.reject(cause),
        },
      );
      const result = await Effect.runPromise(
        Effect.match(supervision.handle(frame("probe", fakeIdentity(30))), {
          onFailure: (error) => ({ ok: false as const, error }),
          onSuccess: () => ({ ok: true as const }),
        }),
      );

      expect(result).toEqual({ ok: false, error: cause });
      expect(supervision.size).toBe(0);
    }
  });

  it("retains a verified lease when an ACK callback never arrives before its deadline", async () => {
    const supervision = createOwnedProcessSupervision(
      { send: () => true },
      () => undefined,
      inertOs,
    );
    const program = Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Effect.exit(supervision.handle(frame("no-ack", fakeIdentity(31)))),
      );
      yield* TestClock.adjust("5 seconds");
      return yield* Fiber.join(fiber);
    });

    const exit = await Effect.runPromise(
      Effect.provide(program, TestClock.layer()),
    );
    expect(exit._tag).toBe("Failure");
    expect(supervision.size).toBe(1);
  });

  it("rejects duplicate registration and mismatched release without dropping the lease", async () => {
    const supervision = createOwnedProcessSupervision(
      acknowledgingHost,
      () => undefined,
      inertOs,
    );
    const identity = fakeIdentity(32);
    const register = frame("same-id", identity);
    await Effect.runPromise(supervision.handle(register));

    const duplicate = await Effect.runPromiseExit(supervision.handle(register));
    const mismatchedRelease = await Effect.runPromiseExit(
      supervision.handle(frame("same-id", fakeIdentity(33), "release")),
    );

    expect(duplicate._tag).toBe("Failure");
    expect(mismatchedRelease._tag).toBe("Failure");
    expect(supervision.size).toBe(1);
    await Effect.runPromise(
      supervision.handle(frame("same-id", identity, "release")),
    );
    expect(supervision.size).toBe(0);
  });

  it("limits concurrent cleanup and returns false at the shared cleanup deadline", async () => {
    let active = 0;
    let peakActive = 0;
    let started = 0;
    let signalStarted: (() => void) | undefined;
    const allStarted = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let finishTerminations: (() => void) | undefined;
    const terminations = new Promise<void>((resolve) => {
      finishTerminations = resolve;
    });
    const supervision = createOwnedProcessSupervision(
      acknowledgingHost,
      () => undefined,
      {
        ...inertOs,
        terminate: async () => {
          active += 1;
          started += 1;
          peakActive = Math.max(peakActive, active);
          if (started === 8) signalStarted?.();
          await terminations;
          active -= 1;
          return { confirmed: true };
        },
      },
    );
    for (let index = 1; index <= 16; index += 1) {
      await Effect.runPromise(
        supervision.handle(frame(`pending-${index}`, fakeIdentity(index))),
      );
    }

    const program = Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.exit(supervision.cleanup()));
      yield* Effect.promise(() => allStarted);
      yield* TestClock.adjust("5 seconds");
      return yield* Fiber.join(fiber);
    });
    const exit = await Effect.runPromise(
      Effect.provide(program, TestClock.layer()),
    );
    finishTerminations?.();

    expect(exit._tag).toBe("Success");
    if (exit._tag === "Success") expect(exit.value).toBe(false);
    expect(peakActive).toBe(8);
    expect(supervision.size).toBe(16);
  });

  it("keeps leases whose cleanup result is failed and reports the original cause", async () => {
    const report: unknown[] = [];
    const identity = fakeIdentity(41);
    const supervision = createOwnedProcessSupervision(
      acknowledgingHost,
      (cause) => report.push(cause),
      {
        ...inertOs,
        terminate: () => Promise.reject(undefined),
      },
    );
    await Effect.runPromise(
      supervision.handle(frame("failed-cleanup", identity)),
    );

    await expect(Effect.runPromise(supervision.cleanup())).resolves.toBe(false);
    expect(report).toContain(undefined);
    expect(supervision.size).toBe(1);
  });

  it("retains and stops a process when registration ACK delivery fails", async () => {
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => undefined, 1000)"],
      { detached: true, stdio: "ignore" },
    );
    if (child.pid === undefined) throw new Error("Worker did not start");
    child.unref();
    children.push(child.pid);

    const identity = await captureOwnedProcessIdentity(child.pid);
    const host = {
      send(_message: string, callback?: (error: Error | null) => void) {
        queueMicrotask(() => callback?.(new Error("IPC ACK send failed")));
        return true;
      },
    };
    const supervision = createOwnedProcessSupervision(host, () => undefined);
    const frame: OwnedProcessFrame = {
      type: "runner.owned-process",
      action: "register",
      id: "ack-rejection-test",
      identity,
    };

    const handled = await Effect.runPromiseExit(supervision.handle(frame));
    expect(handled._tag).toBe("Failure");
    expect(supervision.size).toBe(1);
    await expect(Effect.runPromise(supervision.cleanup())).resolves.toBe(true);
    expect(supervision.size).toBe(0);
  });
});
