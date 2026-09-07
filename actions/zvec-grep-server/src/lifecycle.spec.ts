import { describe, expect, it, vi } from "vitest";
import type {
  DetachedProcess,
  ProcessIdentity,
} from "@seqlane/action-service-lifecycle";
import {
  packageExecutionDirectory,
  processAnchorPath,
  runZvecGrepLifecycle,
  type ZvecGrepLifecycleDependencies,
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

const input = {
  packageManager: "pnpm",
  packageSpec: "@zvec/zvec-grep@0.2.1",
  projectDirectory: "/review-target",
  listen: "127.0.0.1:7999",
  home: "/tmp/zvec-grep",
  embedding: "local/potion-code-16m-v2",
  maxFilesize: "1M",
  additionalGlobs: ["src/**"],
  environment: { PATH: "/usr/bin" },
  logPath: "/tmp/zvec-grep.log",
  timeoutMilliseconds: 30_000,
};

function dependencies(
  overrides: Partial<ZvecGrepLifecycleDependencies> = {},
): ZvecGrepLifecycleDependencies {
  return {
    assertDirectory: vi.fn(async () => undefined),
    runCommand: vi.fn(async () => undefined),
    runReadinessCommand: vi.fn(async () => undefined),
    waitForCommandHealth: vi.fn(async (check) => check()),
    spawnDetached: vi.fn(async () => service),
    adoptDetachedProcess: vi.fn(async () => undefined),
    terminateProcessGroup: vi.fn(async () => true),
    ...overrides,
  };
}

describe("zvec-grep lifecycle", () => {
  it("runs the complete lifecycle from the shipped action directory", async () => {
    const events: string[] = [];
    const deps = dependencies({
      assertDirectory: vi.fn(async () => {
        events.push("validate");
      }),
      runCommand: vi.fn(async ({ args }) => {
        events.push(args[2] === "version" ? "resolve" : "index");
      }),
      spawnDetached: vi.fn(async ({ cwd }) => {
        events.push(`spawn:${cwd}`);
        return service;
      }),
      adoptDetachedProcess: vi.fn(async () => {
        events.push("adopt");
      }),
      waitForCommandHealth: vi.fn(async (check) => {
        events.push("wait");
        await check();
      }),
      runReadinessCommand: vi.fn(async () => {
        events.push("readiness");
      }),
    });

    const saveState = vi.fn((name: string) => events.push(`state:${name}`));

    await runZvecGrepLifecycle(input, { saveState, warning: vi.fn() }, deps);

    expect(events).toEqual([
      "validate",
      "resolve",
      "index",
      `spawn:${packageExecutionDirectory()}`,
      "state:pid",
      "state:process-group-id",
      "state:process-start-time",
      "state:sentinel-pid",
      "state:sentinel-process-group-id",
      "state:sentinel-process-start-time",
      "adopt",
      "wait",
      "readiness",
    ]);
    expect(deps.spawnDetached).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "pnpm",
        cwd: packageExecutionDirectory(),
        anchorPath: processAnchorPath(),
      }),
    );
  });

  it("cleans up the service when readiness fails", async () => {
    const deps = dependencies({
      waitForCommandHealth: vi.fn(async () => {
        throw new Error("not ready");
      }),
    });

    await expect(
      runZvecGrepLifecycle(
        input,
        { saveState: vi.fn(), warning: vi.fn() },
        deps,
      ),
    ).rejects.toThrow("not ready");
    expect(deps.terminateProcessGroup).toHaveBeenCalledWith(
      service.pid,
      service.identity,
      { pid: service.sentinelPid, identity: service.sentinelIdentity },
    );
  });
});
