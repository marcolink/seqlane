// @test-scope ./lifecycle.ts
// @test-scope ./commands.ts
// @test-scope ./readiness.ts

import { Effect } from "effect";
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
    assertDirectory: vi.fn(() => Effect.void),
    runCommand: vi.fn(() => Effect.void),
    runReadinessCommand: vi.fn(() => Effect.void),
    waitForCommandHealth: vi.fn((check) => check()),
    spawnDetached: vi.fn(() => Effect.succeed(service)),
    adoptDetachedProcess: vi.fn(() => Effect.void),
    completeDetachedProcessHandoff: vi.fn(() => Effect.void),
    ...overrides,
  };
}

describe("zvec-grep lifecycle", () => {
  it("runs setup, saves ownership, adopts, and passes readiness before handoff", async () => {
    const events: string[] = [];
    const deps = dependencies({
      assertDirectory: vi.fn(() =>
        Effect.sync(() => {
          events.push("validate");
        }),
      ),
      runCommand: vi.fn(({ args }) =>
        Effect.sync(() => {
          events.push(args[2] === "version" ? "resolve" : "index");
        }),
      ),
      spawnDetached: vi.fn(({ cwd }) =>
        Effect.sync(() => {
          events.push(`spawn:${cwd}`);
          return service;
        }),
      ),
      adoptDetachedProcess: vi.fn(() =>
        Effect.sync(() => {
          events.push("adopt");
        }),
      ),
      waitForCommandHealth: vi.fn((check: () => Effect.Effect<void, Error>) =>
        Effect.gen(function* () {
          events.push("wait");
          yield* check();
        }),
      ),
      runReadinessCommand: vi.fn(() =>
        Effect.sync(() => {
          events.push("readiness");
        }),
      ),
      completeDetachedProcessHandoff: vi.fn(() =>
        Effect.sync(() => {
          events.push("handoff");
        }),
      ),
    });

    const saveState = vi.fn((name: string) => events.push(`state:${name}`));

    await Effect.runPromise(
      runZvecGrepLifecycle(input, { saveState, warning: vi.fn() }, deps),
    );

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
      "handoff",
    ]);
    expect(deps.spawnDetached).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "pnpm",
        cwd: packageExecutionDirectory(),
        anchorPath: processAnchorPath(),
      }),
    );
  });

  it("keeps scoped cleanup ownership when readiness fails", async () => {
    const complete = vi.fn(() => Effect.void);
    const deps = dependencies({
      waitForCommandHealth: vi.fn(() => Effect.fail(new Error("not ready"))),
      completeDetachedProcessHandoff: complete,
    });

    await expect(
      Effect.runPromise(
        runZvecGrepLifecycle(
          input,
          { saveState: vi.fn(), warning: vi.fn() },
          deps,
        ),
      ),
    ).rejects.toThrow("not ready");
    expect(complete).not.toHaveBeenCalled();
  });

  it("does not adopt when saving validated ownership fails", async () => {
    const adopt = vi.fn(() => Effect.void);
    const deps = dependencies({ adoptDetachedProcess: adopt });

    await expect(
      Effect.runPromise(
        runZvecGrepLifecycle(
          input,
          {
            saveState: () => {
              throw new Error("state write failed");
            },
            warning: vi.fn(),
          },
          deps,
        ),
      ),
    ).rejects.toThrow("process ownership could not be saved");
    expect(adopt).not.toHaveBeenCalled();
  });
});
