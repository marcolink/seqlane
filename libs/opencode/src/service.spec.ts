// @test-scope ./service.ts

import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { startOpenCodeService } from "./service.js";

function fakeChild(): ChildProcess & EventEmitter {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  Object.assign(child, {
    exitCode: null,
    signalCode: null,
    pid: 424_242,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(() => {
      Object.assign(child, { exitCode: 0 });
      child.emit("exit", 0, null);
      return true;
    }),
  });
  return child;
}

function ownedChildPid(child: ChildProcess): number {
  if (child.pid === undefined) throw new Error("fake child has no PID");
  return child.pid;
}

function mockOwnedProcessGroup(child: ChildProcess & EventEmitter) {
  return vi.spyOn(process, "kill").mockImplementation(((pid, signal) => {
    if (pid !== -ownedChildPid(child))
      throw new Error("unexpected process group");
    if (signal === 0) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }
      return true;
    }
    Object.assign(child, { exitCode: 0 });
    child.emit("exit", 0, null);
    return true;
  }) as typeof process.kill);
}

describe("owned OpenCode startup", () => {
  it("uses an ephemeral loopback endpoint and waits for health", async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const started = startOpenCodeService({
      workspace: "/workspace",
      signal: new AbortController().signal,
      spawn: spawn as unknown as typeof import("node:child_process").spawn,
      fetch: vi.fn(async () => new Response(null, { status: 200 })),
    });
    child.stdout?.emit(
      "data",
      Buffer.from("opencode server listening on http://127.0.0.1:4173\n"),
    );

    const service = await started;
    expect(service).toMatchObject({
      url: "http://127.0.0.1:4173",
    });
    expect(spawn).toHaveBeenCalledWith(
      "opencode",
      expect.arrayContaining(["--hostname=127.0.0.1", "--port=0"]),
      expect.objectContaining({ cwd: "/workspace" }),
    );
    child.stderr?.emit("data", Buffer.from("still draining native logs\n"));
    expect(service.diagnostics()).toContain("still draining native logs");
    await service.close();
  });

  it("uses a requested loopback port and rejects a different endpoint", async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const started = startOpenCodeService({
      workspace: "/workspace",
      signal: new AbortController().signal,
      host: "127.0.0.1",
      port: 4123,
      spawn: spawn as unknown as typeof import("node:child_process").spawn,
      fetch: vi.fn(async () => new Response(null, { status: 200 })),
      startupTimeoutMs: 1,
    });
    child.stdout?.emit(
      "data",
      Buffer.from("opencode server listening on http://127.0.0.1:4173\\n"),
    );

    await expect(started).rejects.toThrow("did not become ready");
    expect(spawn).toHaveBeenCalledWith(
      "opencode",
      expect.arrayContaining(["--hostname=127.0.0.1", "--port=4123"]),
      expect.anything(),
    );
  });

  it("accepts HTTP default port 80 after URL normalization", async () => {
    const child = fakeChild();
    const started = startOpenCodeService({
      workspace: "/workspace",
      signal: new AbortController().signal,
      host: "127.0.0.1",
      port: 80,
      spawn: (() => child) as typeof import("node:child_process").spawn,
      fetch: vi.fn(async () => new Response(null, { status: 200 })),
    });
    child.stdout?.emit(
      "data",
      Buffer.from("opencode server listening on http://127.0.0.1:80\\n"),
    );

    await expect(started).resolves.toMatchObject({ url: "http://127.0.0.1" });
  });

  it("stops the owned child before reporting an aborted startup", async () => {
    const controller = new AbortController();
    const child = fakeChild();
    const kill = mockOwnedProcessGroup(child);
    const started = startOpenCodeService({
      workspace: process.cwd(),
      signal: controller.signal,
      spawn: (() => child) as typeof import("node:child_process").spawn,
      startupTimeoutMs: 1_000,
    });
    controller.abort();

    try {
      await expect(started).rejects.toMatchObject({
        name: "OpenCodeServiceStartupError",
      });
      expect(kill).toHaveBeenCalledWith(-ownedChildPid(child), "SIGTERM");
    } finally {
      kill.mockRestore();
    }
  });

  it("reports a missing OpenCode executable without waiting for a child exit", async () => {
    const child = fakeChild();
    Object.assign(child, { pid: undefined });
    const started = startOpenCodeService({
      workspace: process.cwd(),
      signal: new AbortController().signal,
      spawn: (() => child) as typeof import("node:child_process").spawn,
      startupTimeoutMs: 1_000,
    });
    child.emit(
      "error",
      Object.assign(new Error("not found"), { code: "ENOENT" }),
    );

    await expect(started).rejects.toThrow("OpenCode executable is unavailable");
  });

  it("kills an owned service after readiness times out", async () => {
    const child = fakeChild();
    const kill = mockOwnedProcessGroup(child);
    try {
      await expect(
        startOpenCodeService({
          workspace: process.cwd(),
          signal: new AbortController().signal,
          spawn: (() => child) as typeof import("node:child_process").spawn,
          startupTimeoutMs: 1,
        }),
      ).rejects.toThrow("did not become ready");
      expect(kill).toHaveBeenCalledWith(-ownedChildPid(child), "SIGTERM");
    } finally {
      kill.mockRestore();
    }
  });

  it("keeps targeting the owned group until descendants exit after the leader", async () => {
    const child = fakeChild();
    let groupAlive = true;
    const kill = vi.spyOn(process, "kill").mockImplementation(((
      pid,
      signal,
    ) => {
      if (pid !== -ownedChildPid(child)) {
        throw new Error("unexpected process group");
      }
      if (signal === 0) {
        if (groupAlive) return true;
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }
      if (signal === "SIGTERM") {
        Object.assign(child, { exitCode: 0 });
        child.emit("exit", 0, null);
        return true;
      }
      if (signal === "SIGKILL") {
        groupAlive = false;
        return true;
      }
      throw new Error("unexpected signal");
    }) as typeof process.kill);
    const started = startOpenCodeService({
      workspace: process.cwd(),
      signal: new AbortController().signal,
      spawn: (() => child) as typeof import("node:child_process").spawn,
      fetch: vi.fn(async () => new Response(null, { status: 200 })),
      shutdownTimeoutMs: 1,
    });
    child.stdout?.emit(
      "data",
      Buffer.from("opencode server listening on http://127.0.0.1:4173\n"),
    );

    try {
      await (await started).close();

      expect(kill).toHaveBeenCalledWith(-ownedChildPid(child), "SIGTERM");
      expect(kill).toHaveBeenCalledWith(-ownedChildPid(child), "SIGKILL");
      expect(
        kill.mock.calls.every(([pid]) => pid === -ownedChildPid(child)),
      ).toBe(true);
    } finally {
      kill.mockRestore();
    }
  });

  it("preserves a startup failure when owned-process cleanup also fails", async () => {
    const child = fakeChild();
    const kill = vi.spyOn(process, "kill").mockImplementation(((
      pid,
      signal,
    ) => {
      if (pid !== -ownedChildPid(child))
        throw new Error("unexpected process group");
      if (signal === 0) return true;
      throw Object.assign(new Error("permission denied"), { code: "EPERM" });
    }) as typeof process.kill);
    try {
      await expect(
        startOpenCodeService({
          workspace: process.cwd(),
          signal: new AbortController().signal,
          spawn: (() => child) as typeof import("node:child_process").spawn,
          startupTimeoutMs: 1,
        }),
      ).rejects.toMatchObject({
        name: "OpenCodeServiceStartupError",
        message: expect.stringContaining("did not become ready"),
        cleanupFailure: expect.objectContaining({
          name: "OpenCodeServiceCleanupError",
        }),
      });
      expect(child.listenerCount("error")).toBeGreaterThan(0);
      expect(child.stdout?.listenerCount("data")).toBeGreaterThan(0);
    } finally {
      kill.mockRestore();
    }
  });
});
