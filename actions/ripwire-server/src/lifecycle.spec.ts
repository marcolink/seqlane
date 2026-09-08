// @test-scope ./lifecycle.ts
// @test-scope ./commands.ts
// @test-scope ./port.ts
// @test-scope ./state.ts

import { describe, expect, it, vi } from "vitest";
import type {
  DetachedProcess,
  ProcessIdentity,
} from "@seqlane/action-service-lifecycle";
import { parseRipwireInputs } from "./config.js";
import {
  packageExecutionDirectory,
  processAnchorPath,
  RipwireStartupError,
  runRipwireLifecycle,
  type RipwireLifecycleDependencies,
} from "./lifecycle.js";

const identity: ProcessIdentity = {
  processGroupId: 42,
  processStartTime: "start",
};
const service = {
  pid: 41,
  identity,
  sentinelPid: 40,
  sentinelIdentity: identity,
  anchor: {},
} as DetachedProcess;
const config = parseRipwireInputs({
  workingDirectory: "/tmp/project",
  mcpToken: undefined,
});

function dependencies(
  overrides: Partial<RipwireLifecycleDependencies> = {},
): RipwireLifecycleDependencies {
  return {
    assertDirectory: vi.fn(async () => undefined),
    assertListenAvailable: vi.fn(async () => undefined),
    spawnDetached: vi.fn(async () => service),
    adoptDetachedProcess: vi.fn(async () => undefined),
    terminateProcessGroup: vi.fn(async () => true),
    readProcessIdentity: vi.fn(async () => identity),
    isProcessAlive: vi.fn(() => true),
    checkMcpInitialize: vi.fn(async () => undefined),
    waitForMcpHealth: vi.fn(async (check) => check(1_000)),
    ...overrides,
  };
}

describe("Ripwire lifecycle", () => {
  it("persists all identities before readiness and starts from the install directory", async () => {
    const events: string[] = [];
    const deps = dependencies({
      assertDirectory: vi.fn(async () => {
        events.push("validate");
      }),
      assertListenAvailable: vi.fn(async () => {
        events.push("port");
      }),
      spawnDetached: vi.fn(async (options) => {
        events.push(`spawn:${options.cwd}`);
        return service;
      }),
      adoptDetachedProcess: vi.fn(async () => {
        events.push("adopt");
      }),
      waitForMcpHealth: vi.fn(async (check) => {
        events.push("wait");
        await check(1_000);
      }),
      checkMcpInitialize: vi.fn(async () => {
        events.push("ready");
      }),
    });
    const saveState = vi.fn((name: string) => events.push(`state:${name}`));
    await runRipwireLifecycle(
      {
        config,
        binaryDirectory: "/tmp/ripwire-install",
        logPath: "/tmp/ripwire.log",
        environment: { PATH: "/usr/bin" },
        sessionToken: "session-token",
      },
      { saveState, warning: vi.fn() },
      deps,
    );
    expect(events).toEqual([
      "validate",
      "port",
      "spawn:/tmp/ripwire-install",
      "state:service-state",
      "adopt",
      "wait",
      "ready",
    ]);
    expect(deps.spawnDetached).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "ripwire",
        cwd: "/tmp/ripwire-install",
        anchorPath: processAnchorPath(),
      }),
    );
    expect(deps.spawnDetached).toHaveBeenCalledWith(
      expect.objectContaining({ args: expect.not.arrayContaining(["secret"]) }),
    );
    expect(deps.spawnDetached).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({ RIPWIRE_MCP_TOKEN: "session-token" }),
      }),
    );
    expect(deps.checkMcpInitialize).toHaveBeenCalledWith(
      config.mcpUrl,
      "session-token",
      1_000,
    );
    expect(packageExecutionDirectory()).toBeDefined();
  });

  it("cleans up when readiness fails", async () => {
    const deps = dependencies({
      waitForMcpHealth: vi.fn(async () => {
        throw new Error("not ready");
      }),
    });
    await expect(
      runRipwireLifecycle(
        {
          config,
          binaryDirectory: "/tmp/ripwire-install",
          logPath: "/tmp/ripwire.log",
          environment: {},
          sessionToken: "session-token",
        },
        { saveState: vi.fn(), warning: vi.fn() },
        deps,
      ),
    ).rejects.toMatchObject({
      name: "RipwireStartupError",
      cleanupSucceeded: true,
    } satisfies Partial<RipwireStartupError>);
    expect(deps.terminateProcessGroup).toHaveBeenCalledWith(
      service.pid,
      service.identity,
      { pid: service.sentinelPid, identity: service.sentinelIdentity },
    );
  });

  it("retains ownership as ambiguous when spawn rejects without state", async () => {
    const terminateProcessGroup = vi.fn(async () => true);
    const deps = dependencies({
      spawnDetached: vi.fn(async () => {
        throw new Error("process ownership ambiguous");
      }),
      terminateProcessGroup,
    });
    await expect(
      runRipwireLifecycle(
        {
          config,
          binaryDirectory: "/tmp/ripwire-install",
          logPath: "/tmp/ripwire.log",
          environment: {},
          sessionToken: "session-token",
        },
        { saveState: vi.fn(), warning: vi.fn() },
        deps,
      ),
    ).rejects.toMatchObject({
      name: "RipwireStartupError",
      cleanupSucceeded: false,
      message: "process ownership ambiguous",
    } satisfies Partial<RipwireStartupError>);
    expect(terminateProcessGroup).not.toHaveBeenCalled();
  });

  it("warns when startup cleanup cannot verify the process group", async () => {
    const warning = vi.fn();
    const deps = dependencies({
      waitForMcpHealth: vi.fn(async () => {
        throw new Error("not ready");
      }),
      terminateProcessGroup: vi.fn(async () => false),
    });
    await expect(
      runRipwireLifecycle(
        {
          config,
          binaryDirectory: "/tmp/ripwire-install",
          logPath: "/tmp/ripwire.log",
          environment: {},
          sessionToken: "session-token",
        },
        { saveState: vi.fn(), warning },
        deps,
      ),
    ).rejects.toMatchObject({
      name: "RipwireStartupError",
      cleanupSucceeded: false,
    } satisfies Partial<RipwireStartupError>);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("could not be verified"),
    );
  });

  it("cleans up when the process identity or liveness check fails", async () => {
    const deps = dependencies({
      isProcessAlive: vi.fn(() => false),
    });
    await expect(
      runRipwireLifecycle(
        {
          config,
          binaryDirectory: "/tmp/ripwire-install",
          logPath: "/tmp/ripwire.log",
          environment: {},
          sessionToken: "session-token",
        },
        { saveState: vi.fn(), warning: vi.fn() },
        deps,
      ),
    ).rejects.toThrow("exited before startup completed");
    expect(deps.terminateProcessGroup).toHaveBeenCalled();
  });
});
