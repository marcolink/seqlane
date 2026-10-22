// @test-scope ./identity.ts
import {
  execFile as execFileCallback,
  spawn,
  type ChildProcess,
} from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  OwnedProcessIdentityError,
  captureOwnedProcessIdentity,
  confirmOwnedProcessGroupStopped,
  confirmOwnedProcessStopped,
  isOwnedProcessIdentityCurrent,
  terminateOwnedProcess,
} from "./identity.js";

const children: ChildProcess[] = [];
const execFile = promisify(execFileCallback);
const reportedPidsSchema = z
  .object({
    childPid: z.number().int().positive().safe(),
    grandchildPid: z.number().int().positive().safe(),
  })
  .strict();

function waitForMessage(
  child: ChildProcess,
): Promise<z.infer<typeof reportedPidsSchema>> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("message", (message: unknown) => {
      const parsed = reportedPidsSchema.safeParse(message);
      if (parsed.success) resolve(parsed.data);
      else reject(new Error("Child did not report valid descendant pids"));
    });
  });
}

function startResistantGroup(): {
  leader: ChildProcess;
  ready: Promise<z.infer<typeof reportedPidsSchema>>;
} {
  const script = [
    'const { spawn } = require("node:child_process");',
    "const childScript = ['const { spawn } = require(\"node:child_process\");', 'const grandchild = spawn(process.execPath, [\"-e\", \"process.on(\\'SIGTERM\\', () => {}); setInterval(() => {}, 1000)\"], { stdio: \"ignore\" });', 'process.on(\"SIGTERM\", () => {});', 'process.send({ childPid: process.pid, grandchildPid: grandchild.pid });', 'setInterval(() => {}, 1000);'].join(\"\\n\");",
    'const child = spawn(process.execPath, ["-e", childScript], { stdio: ["ignore", "ignore", "ignore", "ipc"] });',
    'child.on("message", (message) => process.send(message));',
    'process.on("SIGTERM", () => {});',
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const leader = spawn(process.execPath, ["-e", script], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  children.push(leader);
  return { leader, ready: waitForMessage(leader) };
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

async function processState(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFile(
      "ps",
      ["-o", "stat=", "-p", String(pid)],
      {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
      },
    );
    return stdout.trim() || undefined;
  } catch (cause) {
    const missing = z
      .object({
        code: z.literal(1),
        stdout: z.literal(""),
        stderr: z.literal(""),
      })
      .safeParse(cause);
    if (missing.success) return undefined;
    throw cause;
  }
}

async function expectInactive(pid: number): Promise<void> {
  const state = await processState(pid);
  if (state !== undefined) {
    expect(state.startsWith("Z") || state.startsWith("X")).toBe(true);
  }
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group may already have exited.
      }
      await waitForExit(child);
    }
  }
});

describe("owned process identity", () => {
  it("preserves typed capture errors for invalid process ids", async () => {
    await expect(captureOwnedProcessIdentity(0)).rejects.toBeInstanceOf(
      OwnedProcessIdentityError,
    );
  });

  it("rejects invalid process group ids with the typed identity error", async () => {
    await expect(confirmOwnedProcessGroupStopped(0)).rejects.toBeInstanceOf(
      OwnedProcessIdentityError,
    );
  });

  it.skipIf(process.platform === "win32")(
    "confirms a naturally exited process group without signaling it",
    async () => {
      const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
        detached: true,
        stdio: "ignore",
      });
      children.push(child);
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", () => resolve());
      });

      expect(await confirmOwnedProcessGroupStopped(child.pid!)).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "terminates a resistant detached group and leaves a foreign group alive",
    async () => {
      const owned = startResistantGroup();
      const { childPid, grandchildPid } = await owned.ready;
      const identity = await captureOwnedProcessIdentity(owned.leader.pid!);
      expect(identity.processGroupId).toBe(identity.pid);

      const foreign = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { detached: true, stdio: "ignore" },
      );
      children.push(foreign);
      await new Promise<void>((resolve, reject) => {
        foreign.once("error", reject);
        foreign.once("spawn", () => resolve());
      });

      expect(await isOwnedProcessIdentityCurrent(identity)).toBe(true);
      expect((await terminateOwnedProcess(identity, "SIGTERM")).confirmed).toBe(
        false,
      );
      expect((await terminateOwnedProcess(identity, "SIGKILL")).confirmed).toBe(
        true,
      );
      await waitForExit(owned.leader);
      expect(await confirmOwnedProcessStopped(identity)).toBe(true);
      expect(await confirmOwnedProcessGroupStopped(identity.pid)).toBe(true);
      await expectInactive(childPid);
      await expectInactive(grandchildPid);
      expect(() => process.kill(foreign.pid!, 0)).not.toThrow();
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not authorize a signal with an altered birth identity",
    async () => {
      const owned = startResistantGroup();
      const { childPid, grandchildPid } = await owned.ready;
      const identity = await captureOwnedProcessIdentity(owned.leader.pid!);
      const altered = {
        ...identity,
        birthIdentity: `${identity.birthIdentity}0`,
      };
      expect(await isOwnedProcessIdentityCurrent(altered)).toBe(false);
      expect((await terminateOwnedProcess(altered, "SIGKILL")).confirmed).toBe(
        false,
      );
      expect(() => process.kill(identity.pid, 0)).not.toThrow();
      expect(() => process.kill(childPid, 0)).not.toThrow();
      expect(() => process.kill(grandchildPid, 0)).not.toThrow();
      expect(await confirmOwnedProcessGroupStopped(identity.pid)).toBe(false);
      expect((await terminateOwnedProcess(identity, "SIGKILL")).confirmed).toBe(
        true,
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "reports uncertainty when the leader is gone but its group still has active work",
    async () => {
      const owned = startResistantGroup();
      const { grandchildPid } = await owned.ready;
      const identity = await captureOwnedProcessIdentity(owned.leader.pid!);
      process.kill(identity.pid, "SIGKILL");
      await waitForExit(owned.leader);
      expect(await confirmOwnedProcessStopped(identity)).toBe(false);
      expect((await terminateOwnedProcess(identity, "SIGKILL")).confirmed).toBe(
        false,
      );
      expect(() => process.kill(grandchildPid, 0)).not.toThrow();
      expect(await confirmOwnedProcessGroupStopped(identity.pid)).toBe(false);
      try {
        process.kill(-identity.processGroupId, "SIGKILL");
      } catch {
        // Clean up the surviving descendant after asserting uncertainty.
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "confirms an already stopped owned group after its leader exits",
    async () => {
      const owned = startResistantGroup();
      await owned.ready;
      const identity = await captureOwnedProcessIdentity(owned.leader.pid!);
      process.kill(-identity.processGroupId, "SIGKILL");
      await waitForExit(owned.leader);

      expect(await isOwnedProcessIdentityCurrent(identity)).toBe(false);
      expect((await terminateOwnedProcess(identity, "SIGKILL")).confirmed).toBe(
        true,
      );
    },
  );
});
