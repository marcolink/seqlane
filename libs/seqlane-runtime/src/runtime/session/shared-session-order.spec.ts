// @test-scope ../compile/compile-plan.ts
// @test-scope ./session-preflight.ts
// @test-scope ./shared-session-order.ts
import type { PlanNode, TaskDefinition } from "@seqlane/core";
import { describe, expect, it } from "vitest";
import { EffectCompiler } from "../compile/compile-plan.js";
import { resolveCompiledWorkflowSessions } from "./session-preflight.js";
import type {
  ResolvedExecutorSession,
  SessionResolver,
} from "./session-resolution.js";
import { UnorderedSharedSessionError } from "./shared-session-order.js";
import { runCompiledWorkflow } from "../execution/workflow-run.js";

function task(
  nodeId: string,
  dependsOn: readonly string[] = [],
  workspace: "shared" | "exclusive" = "shared",
): Extract<PlanNode, { readonly type: "task" }> {
  return {
    type: "task",
    taskId: nodeId,
    nodeId,
    workspace,
    input: {},
    dependsOn,
  };
}

function taskDefinition(
  taskId: string,
  workspace: "shared" | "exclusive" = "shared",
): TaskDefinition {
  const schema = { parse: (value: unknown) => value };
  return {
    id: taskId,
    workspace,
    input: schema,
    output: schema,
    goal: () => taskId,
  };
}

function sharedSessionResolver(
  executor: ResolvedExecutorSession["executor"],
): SessionResolver {
  const shared = { key: Symbol("test-shared-session"), executor };
  return { resolve: async () => shared };
}

describe("shared-session order preflight", () => {
  it("accepts a shared-session pair with a transitive DAG dependency", async () => {
    const executor = { execute: async () => ({}) };
    const compiled = new EffectCompiler().compileWorkflow(
      {
        workflow: { id: "shared-session-order" },
        nodes: [
          task("second", ["middle"]),
          task("middle", ["first"]),
          task("first"),
        ],
        output: { type: "ref", nodeId: "second", path: [] },
      },
      {
        createInvocationId: (nodeId) => `inv:${nodeId}`,
        executors: new Map([["test", executor]]),
        sessionResolver: sharedSessionResolver(executor),
        taskDefinitions: new Map([
          ["first", taskDefinition("first")],
          ["middle", taskDefinition("middle")],
          ["second", taskDefinition("second")],
        ]),
      },
    );
    await resolveCompiledWorkflowSessions(compiled);

    expect(compiled.context.sharedSessionPairs).toEqual([
      {
        first: { nodeId: "first", invocationId: "inv:first" },
        second: { nodeId: "middle", invocationId: "inv:middle" },
        ordered: true,
      },
      {
        first: { nodeId: "first", invocationId: "inv:first" },
        second: { nodeId: "second", invocationId: "inv:second" },
        ordered: true,
      },
      {
        first: { nodeId: "middle", invocationId: "inv:middle" },
        second: { nodeId: "second", invocationId: "inv:second" },
        ordered: true,
      },
    ]);
  });

  it("rejects an unordered shared-session pair before an executor request", async () => {
    let executorRequests = 0;
    const executor = {
      execute: async () => {
        executorRequests += 1;
        return {};
      },
    };
    const compiled = new EffectCompiler().compileWorkflow(
      {
        workflow: { id: "unordered-shared-session" },
        nodes: [task("first"), task("second")],
        output: { type: "ref", nodeId: "second", path: [] },
      },
      {
        createInvocationId: (nodeId) => `inv:${nodeId}`,
        executors: new Map([["test", executor]]),
        sessionResolver: sharedSessionResolver(executor),
        taskDefinitions: new Map([
          ["first", taskDefinition("first")],
          ["second", taskDefinition("second")],
        ]),
      },
    );
    await expect(resolveCompiledWorkflowSessions(compiled)).rejects.toEqual(
      new UnorderedSharedSessionError({
        first: { nodeId: "first", invocationId: "inv:first" },
        second: { nodeId: "second", invocationId: "inv:second" },
        ordered: false,
      }),
    );
    expect(executorRequests).toBe(0);
  });

  it("materializes every branch before a parent continuation advances", async () => {
    const activity: string[] = [];
    const parentExecutor = {
      execute: async ({ taskId }: { readonly taskId: string }) => {
        activity.push(`parent:${taskId}`);
        return {};
      },
    };
    const childExecutor = {
      execute: async ({ taskId }: { readonly taskId: string }) => {
        activity.push(`branch:${taskId}`);
        return {};
      },
    };
    const parentSession = {
      key: Symbol("parent"),
      executor: parentExecutor,
      checkpoint: async () => {
        activity.push("checkpoint");
        return "source-turn";
      },
      fork: async () => {
        activity.push("fork");
        return { key: Symbol("branch"), executor: childExecutor };
      },
    };
    const compiled = new EffectCompiler().compileWorkflow(
      {
        workflow: { id: "checkpoint-fanout" },
        nodes: [
          task("source"),
          {
            ...task("branch", ["source"]),
            session: { type: "branch" as const, from: "source" },
          },
          {
            ...task("reuse", ["source"]),
            session: { type: "reuse" as const, from: "source" },
          },
        ],
        output: { type: "ref", nodeId: "reuse", path: [] },
      },
      {
        createInvocationId: (nodeId) => `inv:${nodeId}`,
        executors: new Map([["test", parentExecutor]]),
        sessionResolver: { resolve: async () => parentSession },
        taskDefinitions: new Map([
          ["source", taskDefinition("source")],
          ["branch", taskDefinition("branch")],
          ["reuse", taskDefinition("reuse")],
        ]),
      },
    );

    await resolveCompiledWorkflowSessions(compiled);
    await runCompiledWorkflow(compiled);

    expect(activity).toContain("parent:source");
    expect(activity).toContain("branch:branch");
    expect(activity).toContain("parent:reuse");
    expect(activity.indexOf("checkpoint")).toBeLessThan(
      activity.indexOf("fork"),
    );
    expect(activity.indexOf("fork")).toBeLessThan(
      activity.indexOf("parent:reuse"),
    );
  });

  it("fails a branch workflow when the source session cannot fork natively", async () => {
    const executor = { execute: async () => ({}) };
    const compiled = new EffectCompiler().compileWorkflow(
      {
        workflow: { id: "unsupported-session-branch" },
        nodes: [
          task("source"),
          {
            ...task("branch", ["source"]),
            session: { type: "branch" as const, from: "source" },
          },
        ],
        output: { type: "ref", nodeId: "branch", path: [] },
      },
      {
        createInvocationId: (nodeId) => `inv:${nodeId}`,
        executors: new Map([["test", executor]]),
        sessionResolver: {
          resolve: async () => ({ key: Symbol("source"), executor }),
        },
        taskDefinitions: new Map([
          ["source", taskDefinition("source")],
          ["branch", taskDefinition("branch")],
        ]),
      },
    );

    await resolveCompiledWorkflowSessions(compiled);

    await expect(runCompiledWorkflow(compiled)).resolves.toMatchObject({
      status: "failed",
      error: {
        message: expect.stringMatching(/no native checkpoint fork capability/i),
      },
    });
  });
});
