// @test-scope ./lifecycle.ts
// @test-scope ./commands.ts
// @test-scope ./port.ts
// @test-scope ./socket-ownership.ts
// @test-scope ./state.ts

import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type {
  DetachedProcess,
  ProcessIdentity,
} from "@seqlane/action-service-lifecycle";
import { SpawnDetachedError } from "@seqlane/action-service-lifecycle";
import { parseRipwireInputs } from "./config.js";
import {
  packageExecutionDirectory,
  processAnchorPath,
  RipwireStartupError,
  runRipwireLifecycle,
  type RipwireLifecycleDependencies,
} from "./lifecycle.js";

const identity: ProcessIdentity = {
  processGroupId: 41,
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
    assertDirectory: vi.fn(() => Promise.resolve()),
    assertListenAvailable: vi.fn(() => Promise.resolve()),
    spawnDetached: vi.fn(() => Effect.succeed(service)),
    adoptDetachedProcess: vi.fn(() => Effect.void),
    cleanupDetachedProcess: vi.fn(() => Effect.succeed(true)),
    completeDetachedProcessHandoff: vi.fn(() => Effect.void),
    assertListenOwnedByProcess: vi.fn(() => Promise.resolve()),
    readProcessIdentity: vi.fn(() => Effect.succeed(identity)),
    isProcessAlive: vi.fn(() => true),
    checkMcpInitialize: vi.fn(() => Effect.void),
    waitForMcpHealth: vi.fn((check) => check(1_000)),
    ...overrides,
  };
}

const input = {
  config,
  binaryDirectory: "/tmp/ripwire-install",
  logPath: "/tmp/ripwire.log",
  environment: { PATH: "/usr/bin" },
  sessionToken: "session-token",
};

describe("Ripwire lifecycle", () => {
  it("saves validated process and sentinel identities before readiness handoff", async () => {
    const events: string[] = [];
    const deps = dependencies({
      assertDirectory: vi.fn(async () => void events.push("validate")),
      assertListenAvailable: vi.fn(async () => void events.push("port")),
      spawnDetached: vi.fn((options) => {
        events.push(`spawn:${options.cwd}`);
        return Effect.succeed(service);
      }),
      adoptDetachedProcess: vi.fn(() => {
        events.push("adopt");
        return Effect.void;
      }),
      waitForMcpHealth: vi.fn((check) => {
        events.push("wait");
        return check(1_000);
      }),
      checkMcpInitialize: vi.fn(() => {
        events.push("ready");
        return Effect.void;
      }),
      completeDetachedProcessHandoff: vi.fn(() => {
        events.push("handoff");
        return Effect.void;
      }),
    });
    const saveState = vi.fn(
      (name: string) => void events.push(`state:${name}`),
    );

    await Effect.runPromise(
      runRipwireLifecycle(input, { saveState, warning: vi.fn() }, deps),
    );

    expect(events).toEqual([
      "validate",
      "port",
      "spawn:/tmp/ripwire-install",
      "state:service-state",
      "adopt",
      "wait",
      "ready",
      "handoff",
    ]);
    expect(saveState).toHaveBeenCalledWith(
      "service-state",
      JSON.stringify({ pid: 41, identity, sentinel: { pid: 40, identity } }),
    );
    expect(deps.spawnDetached).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "ripwire",
        cwd: "/tmp/ripwire-install",
        anchorPath: processAnchorPath(),
        args: expect.not.arrayContaining(["secret"]),
        env: expect.objectContaining({ RIPWIRE_MCP_TOKEN: "session-token" }),
      }),
    );
    expect(packageExecutionDirectory()).toBeDefined();
  });

  it("retains scoped cleanup ownership until readiness succeeds", async () => {
    const deps = dependencies({
      waitForMcpHealth: vi.fn(() => Effect.fail(new Error("not ready"))),
    });
    await expect(
      Effect.runPromise(
        runRipwireLifecycle(
          input,
          { saveState: vi.fn(), warning: vi.fn() },
          deps,
        ),
      ),
    ).rejects.toMatchObject({
      name: "RipwireStartupError",
      cleanupSucceeded: true,
    } satisfies Partial<RipwireStartupError>);
    expect(deps.cleanupDetachedProcess).toHaveBeenCalledWith(service);
    expect(deps.completeDetachedProcessHandoff).not.toHaveBeenCalled();
  });

  it("does not adopt a service when validated state cannot be saved", async () => {
    const deps = dependencies();
    await expect(
      Effect.runPromise(
        runRipwireLifecycle(
          input,
          {
            saveState: () => {
              throw new Error("state unavailable");
            },
            warning: vi.fn(),
          },
          deps,
        ),
      ),
    ).rejects.toMatchObject({ name: "RipwireStartupError" });
    expect(deps.adoptDetachedProcess).not.toHaveBeenCalled();
    expect(deps.cleanupDetachedProcess).toHaveBeenCalledWith(service);
  });

  it("persists validated ambiguous ownership if spawn cleanup is uncertain", async () => {
    const ownership = { pid: 41, identity };
    const saveState = vi.fn();
    const deps = dependencies({
      spawnDetached: vi.fn(() =>
        Effect.fail(
          new SpawnDetachedError(
            "ripwire",
            new Error("anchor failed after child creation"),
            false,
            ownership,
          ),
        ),
      ),
    });
    await expect(
      Effect.runPromise(
        runRipwireLifecycle(input, { saveState, warning: vi.fn() }, deps),
      ),
    ).rejects.toMatchObject({
      name: "RipwireStartupError",
      cleanupSucceeded: false,
      ownership,
    } satisfies Partial<RipwireStartupError>);
    expect(saveState).toHaveBeenCalledWith(
      "service-state",
      JSON.stringify(ownership),
    );
    expect(deps.adoptDetachedProcess).not.toHaveBeenCalled();
  });

  it("preserves the primary readiness cause when cleanup is unverified", async () => {
    const warning = vi.fn();
    const deps = dependencies({
      waitForMcpHealth: vi.fn(() => Effect.fail(new Error("not ready"))),
      cleanupDetachedProcess: vi.fn(() => Effect.succeed(false)),
    });
    await expect(
      Effect.runPromise(
        runRipwireLifecycle(input, { saveState: vi.fn(), warning }, deps),
      ),
    ).rejects.toMatchObject({
      name: "RipwireStartupError",
      cleanupSucceeded: false,
    });
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("could not be verified"),
    );
  });

  it("does not hand off a dead service after readiness", async () => {
    const deps = dependencies({ isProcessAlive: vi.fn(() => false) });
    await expect(
      Effect.runPromise(
        runRipwireLifecycle(
          input,
          { saveState: vi.fn(), warning: vi.fn() },
          deps,
        ),
      ),
    ).rejects.toThrow("exited before startup completed");
    expect(deps.cleanupDetachedProcess).toHaveBeenCalled();
    expect(deps.completeDetachedProcessHandoff).not.toHaveBeenCalled();
  });
});
