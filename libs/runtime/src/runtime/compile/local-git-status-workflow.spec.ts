// @test-scope ./compile-plan.ts
// @test-scope ../execution/workflow-run.ts
// @test-scope ../invocation/invocation-execution.ts
// @test-scope ../../runner/event-bridge.ts
// @test-scope ../../runner/workflow/plan-snapshot.ts
// @test-scope ../../../../fixtures/src/local-git-status.ts

import type { TaskContext } from "@seqlane/core";
import { buildWorkflow } from "@seqlane/core";
import type { SeqlaneExecutionEvent } from "@seqlane/events";
import {
  gitStatusOutputSchema,
  localGitStatusTask,
  localGitStatusWorkflow,
  summarizeGitStatusTask,
} from "@seqlane/fixtures/local-git-status";
import { describe, expect, it } from "vitest";
import {
  createExecutionEventBridge,
  type ExecutionEventBridge,
} from "../../runner/event-bridge.js";
import { createSeqlanePlanSnapshot } from "../../runner/workflow/plan-snapshot.js";
import { startCompiledWorkflow } from "../execution/workflow-run.js";
import type { ExecutorRequest } from "../execution/executor.js";
import { PlanCompiler } from "./compile-plan.js";
function createEventBridge(
  events: SeqlaneExecutionEvent[],
): ExecutionEventBridge {
  return createExecutionEventBridge(
    async (event) => {
      events.push(event);
    },
    {
      createEventId: (() => {
        let next = 0;
        return () => `event-${++next}`;
      })(),
      clock: () => new Date("2026-09-03T00:00:00.000Z"),
    },
  );
}

describe("local Git status workflow example", () => {
  it("declares direct Git argv without creating a session", async () => {
    const requests: Array<{
      readonly executable: string;
      readonly argv?: readonly string[];
    }> = [];
    const context: TaskContext = {
      exec: async (request) => {
        requests.push(request);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      runAgent: async () => ({}),
    };

    const result = await localGitStatusTask.execute({
      input: {},
      signal: new AbortController().signal,
      context,
    });

    expect(requests).toEqual([
      { executable: "git", argv: ["status", "--porcelain=v1"] },
    ]);
    expect(gitStatusOutputSchema.parse(result)).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
  });

  it("passes typed local Git output to a later agent task without OpenCode", async () => {
    const built = buildWorkflow(localGitStatusWorkflow);
    const localNode = built.plan.nodes[0];
    const agentNode = built.plan.nodes[1];
    if (localNode?.type !== "task" || agentNode?.type !== "task") {
      throw new Error("Expected local and agent task nodes");
    }

    expect(localNode).toMatchObject({
      taskId: localGitStatusTask.id,
      workspace: "shared",
      dependsOn: [],
    });
    expect(localNode).not.toHaveProperty("session");
    expect(agentNode).toMatchObject({
      taskId: summarizeGitStatusTask.id,
      dependsOn: [localNode.nodeId],
    });

    const snapshot = createSeqlanePlanSnapshot(built.plan);
    expect(snapshot.nodes).toEqual([
      {
        planNodeId: localNode.nodeId,
        type: "task",
        label: localGitStatusTask.id,
        taskId: localGitStatusTask.id,
        dependsOn: [],
        siblingOrder: 0,
      },
      {
        planNodeId: agentNode.nodeId,
        type: "task",
        label: summarizeGitStatusTask.id,
        taskId: summarizeGitStatusTask.id,
        dependsOn: [localNode.nodeId],
        siblingOrder: 1,
      },
    ]);

    const events: SeqlaneExecutionEvent[] = [];
    const bridge = createEventBridge(events);
    bridge.emit({ type: "run.started", workId: "git-work", runId: "git-run" });
    bridge.emitPlan(snapshot, "git-work", "git-run");
    const agentRequests: ExecutorRequest[] = [];
    const compiled = new PlanCompiler().compileWorkflow(built.plan, {
      workId: "git-work",
      runId: "git-run",
      createInvocationId: (nodeId) => nodeId,
      workflowInput: {},
      executors: {
        agent: () => ({
          execute: async (request) => {
            agentRequests.push(request);
            const status = gitStatusOutputSchema.parse(request.input);
            return {
              summary: `Git status exited with ${status.exitCode} and returned ${status.stdout.length} stdout bytes.`,
            };
          },
        }),
      },
      workspaceResources: new Map([
        [localGitStatusTask.id, { key: process.cwd() }],
        [summarizeGitStatusTask.id, { key: process.cwd() }],
      ]),
      taskDefinitions: built.taskDefinitions,
      events: bridge,
    });

    const activeRun = startCompiledWorkflow(compiled, {
      emitRunStarted: false,
    });
    await expect(activeRun.outcome).resolves.toMatchObject({
      status: "succeeded",
      result: { summary: expect.stringContaining("Git status exited with 0") },
    });
    await bridge.flush();

    expect(agentRequests).toHaveLength(1);
    expect(agentRequests[0]?.taskId).toBe(summarizeGitStatusTask.id);
    expect(agentRequests[0]?.input).toEqual(
      expect.objectContaining({
        exitCode: 0,
        stdout: expect.any(String),
        stderr: expect.any(String),
      }),
    );

    const localResult = events.find(
      (event) =>
        event.type === "invocation.result" &&
        event.invocationId === localNode.nodeId,
    );
    expect(localResult).toBeDefined();
    expect(localResult).not.toHaveProperty("metrics");
    expect(events.at(-1)).toMatchObject({
      type: "run.succeeded",
      output: { summary: expect.any(String) },
    });
  });
});
