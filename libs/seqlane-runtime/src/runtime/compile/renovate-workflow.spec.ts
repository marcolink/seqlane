// @test-scope ./compile-plan.ts
import type { Plan } from "@seqlane/core";
import {
  createRenovatePlan,
  RENOVATE_INVOCATIONS,
  renovateTaskSchemas,
  renovateValidatorDefinitions,
} from "@seqlane/fixtures/renovate-workflow";
import { describe, expect, it } from "vitest";
import {
  ExecutorError,
  startCompiledWorkflow,
  type SeqlaneEvent,
} from "../../index.js";
import { EffectCompiler } from "./compile-plan.js";
import type {
  ExecutorRequest,
  SeqlaneExecutor,
} from "../execution/executor.js";

interface FakeOpenCodeExecutor {
  readonly executor: SeqlaneExecutor;
  readonly requests: ExecutorRequest[];
  readonly started: Promise<void>;
  readonly aborted: Promise<void>;
}

function createFakeOpenCodeExecutor(
  options: {
    readonly failOnTaskId?: string;
    readonly blockOnTaskId?: string;
  } = {},
): FakeOpenCodeExecutor {
  const requests: ExecutorRequest[] = [];
  let markStarted!: () => void;
  let markAborted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const aborted = new Promise<void>((resolve) => {
    markAborted = resolve;
  });

  const executor: SeqlaneExecutor = {
    execute: async (request) => {
      requests.push(request);

      if (request.taskId === options.failOnTaskId) {
        throw new Error(`fake OpenCode failure in ${request.taskId}`);
      }

      if (request.taskId === options.blockOnTaskId) {
        markStarted();
        await new Promise<never>((_resolve, reject) => {
          const abort = () => {
            markAborted();
            reject(new Error("fake OpenCode request aborted"));
          };

          if (request.signal.aborted) {
            abort();
          } else {
            request.signal.addEventListener("abort", abort, { once: true });
          }
        });
      }

      switch (request.taskId) {
        case RENOVATE_INVOCATIONS.investigate.taskId:
          return {
            files: ["package.json", "pnpm-lock.yaml"],
            rootCause: "Renovate updated a dependency without its peer range",
          };
        case RENOVATE_INVOCATIONS.plan.taskId:
          return {
            steps: ["update peer range", "refresh lockfile"],
            summary: "Apply the dependency and lockfile remediation",
          };
        case RENOVATE_INVOCATIONS.fix.taskId:
          return {
            changedFiles: ["package.json", "pnpm-lock.yaml"],
            summary: "Dependency update and lockfile repaired",
          };
        case RENOVATE_INVOCATIONS.verify.taskId:
          return {
            passed: true,
            summary: "Install and targeted tests pass",
          };
        default:
          throw new Error(`unexpected fake OpenCode task ${request.taskId}`);
      }
    },
  };

  return { executor, requests, started, aborted };
}

function compileRenovateWorkflow(
  plan: Plan,
  fake: FakeOpenCodeExecutor,
  events: SeqlaneEvent[],
) {
  return new EffectCompiler().compileWorkflow(plan, {
    runId: "renovate-run-1",
    workflowInput: {
      dependency: "example-package",
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
      failure: "Renovate's update fails the peer dependency check",
    },
    executors: new Map([["opencode", fake.executor]]),
    workspaceResources: new Map([
      [RENOVATE_INVOCATIONS.investigate.taskId, { key: "/checkout" }],
      [RENOVATE_INVOCATIONS.fix.taskId, { key: "/checkout" }],
      [RENOVATE_INVOCATIONS.verify.taskId, { key: "/checkout" }],
    ]),
    taskSchemas: renovateTaskSchemas,
    validatorDefinitions: renovateValidatorDefinitions,
    events: { emit: (event) => events.push(event) },
  });
}

describe("Renovate-shaped Effect runtime contract", () => {
  it("executes investigate, plan, fix, and verify through Effect", async () => {
    const fake = createFakeOpenCodeExecutor();
    const events: SeqlaneEvent[] = [];
    const compiled = compileRenovateWorkflow(
      createRenovatePlan(),
      fake,
      events,
    );

    const activeRun = startCompiledWorkflow(compiled);
    await expect(activeRun.outcome).resolves.toEqual({
      status: "succeeded",
      result: {
        change: {
          changedFiles: ["package.json", "pnpm-lock.yaml"],
          summary: "Dependency update and lockfile repaired",
        },
        verification: {
          passed: true,
          summary: "Install and targeted tests pass",
        },
      },
    });

    expect(fake.requests.map(({ taskId }) => taskId)).toEqual([
      RENOVATE_INVOCATIONS.investigate.taskId,
      RENOVATE_INVOCATIONS.plan.taskId,
      RENOVATE_INVOCATIONS.fix.taskId,
      RENOVATE_INVOCATIONS.verify.taskId,
    ]);
    expect(compiled.program.steps).toHaveLength(7);
    expect(
      events
        .filter(
          ({ type }) =>
            ![
              "invocation.created",
              "invocation.progress",
              "invocation.output",
              "invocation.input",
              "invocation.result",
            ].includes(type),
        )
        .map(({ type }) => type),
    ).toEqual([
      "run.started",
      "invocation.started",
      "invocation.succeeded",
      "invocation.started",
      "invocation.succeeded",
      "invocation.started",
      "invocation.succeeded",
      "invocation.started",
      "invocation.succeeded",
      "invocation.started",
      "invocation.succeeded",
      "invocation.started",
      "invocation.succeeded",
      "run.succeeded",
    ]);
    expect(
      events.filter(({ type }) => type === "invocation.created"),
    ).toHaveLength(6);
  });

  it("stops downstream Renovate work when a step fails", async () => {
    const fake = createFakeOpenCodeExecutor({
      failOnTaskId: RENOVATE_INVOCATIONS.fix.taskId,
    });
    const events: SeqlaneEvent[] = [];
    const activeRun = startCompiledWorkflow(
      compileRenovateWorkflow(createRenovatePlan(), fake, events),
    );

    await expect(activeRun.outcome).resolves.toMatchObject({
      status: "failed",
      error: expect.any(ExecutorError),
    });
    expect(fake.requests.map(({ taskId }) => taskId)).toEqual([
      RENOVATE_INVOCATIONS.investigate.taskId,
      RENOVATE_INVOCATIONS.plan.taskId,
      RENOVATE_INVOCATIONS.fix.taskId,
    ]);
    expect(
      events.some(
        (event) =>
          event.type === "invocation.started" &&
          event.invocationId === RENOVATE_INVOCATIONS.verify.nodeId,
      ),
    ).toBe(false);
  });

  it("propagates cancellation into the active fake OpenCode request", async () => {
    const fake = createFakeOpenCodeExecutor({
      blockOnTaskId: RENOVATE_INVOCATIONS.fix.taskId,
    });
    const events: SeqlaneEvent[] = [];
    const activeRun = startCompiledWorkflow(
      compileRenovateWorkflow(createRenovatePlan(), fake, events),
    );

    await fake.started;
    await activeRun.cancel();
    await fake.aborted;

    await expect(activeRun.outcome).resolves.toEqual({ status: "cancelled" });
    expect(fake.requests.map(({ taskId }) => taskId)).toEqual([
      RENOVATE_INVOCATIONS.investigate.taskId,
      RENOVATE_INVOCATIONS.plan.taskId,
      RENOVATE_INVOCATIONS.fix.taskId,
    ]);
    expect(events.at(-1)).toEqual({
      type: "run.cancelled",
      workId: "fix-renovate-update:work",
      runId: "renovate-run-1",
    });
  });
});
