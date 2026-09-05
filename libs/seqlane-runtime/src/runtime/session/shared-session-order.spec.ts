// @test-scope ../compile/compile-plan.ts
// @test-scope ../execution/model-preflight.ts
// @test-scope ./session-preflight.ts
// @test-scope ./shared-session-order.ts
import type { ModelSelection, PlanNode, TaskDefinition } from "@seqlane/core";
import { describe, expect, it } from "vitest";
import { PlanCompiler } from "../compile/compile-plan.js";
import { preflightCompiledWorkflowModels } from "../execution/model-preflight.js";
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
    const compiled = new PlanCompiler().compileWorkflow(
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
    const compiled = new PlanCompiler().compileWorkflow(
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
    let activeForks = 0;
    let maximumConcurrentForks = 0;
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
        activeForks += 1;
        maximumConcurrentForks = Math.max(maximumConcurrentForks, activeForks);
        await Promise.resolve();
        activeForks -= 1;
        activity.push("fork");
        return { key: Symbol("branch"), executor: childExecutor };
      },
    };
    const compiled = new PlanCompiler().compileWorkflow(
      {
        workflow: { id: "checkpoint-fanout" },
        nodes: [
          task("source"),
          {
            ...task("branch", ["source"]),
            session: { type: "branch" as const, from: "source" },
          },
          {
            ...task("second-branch", ["source"]),
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
          ["second-branch", taskDefinition("second-branch")],
          ["reuse", taskDefinition("reuse")],
        ]),
      },
    );

    await resolveCompiledWorkflowSessions(compiled);
    await runCompiledWorkflow(compiled);

    expect(activity).toContain("parent:source");
    expect(activity).toContain("branch:branch");
    expect(activity).toContain("parent:reuse");
    expect(maximumConcurrentForks).toBe(1);
    expect(activity.indexOf("checkpoint")).toBeLessThan(
      activity.indexOf("fork"),
    );
    expect(activity.indexOf("fork")).toBeLessThan(
      activity.indexOf("parent:reuse"),
    );
  });

  it("passes the effective selection to isolated resolution and reuses the exact source session", async () => {
    const selection: ModelSelection = {
      model: { provider: "anthropic", model: "claude-sonnet-4-6" },
      reasoning: "high",
    };
    const resolverSelections: Array<ModelSelection | undefined> = [];
    const parentSession: ResolvedExecutorSession = {
      key: Symbol("parent"),
      executor: { execute: async () => ({}) },
    };
    const compiled = new PlanCompiler().compileWorkflow(
      {
        workflow: { id: "session-selection-reuse" },
        nodes: [
          {
            ...task("source"),
            session: { type: "isolated" as const, model: selection },
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
        executors: new Map([["test", parentSession.executor]]),
        sessionResolver: {
          modelCapabilities: {
            executor: "test",
            listModels: async () => [selection.model],
            resolveDefaultModel: async () => selection,
          },
          resolve: async ({ effectiveSelection }) => {
            resolverSelections.push(effectiveSelection);
            return parentSession;
          },
        },
        taskDefinitions: new Map([
          ["source", taskDefinition("source")],
          ["reuse", taskDefinition("reuse")],
        ]),
      },
    );

    await preflightCompiledWorkflowModels(compiled);
    await resolveCompiledWorkflowSessions(compiled);
    await runCompiledWorkflow(compiled);

    expect(resolverSelections).toEqual([selection]);
    const sourceSession = compiled.context.resolvedSessions.get("inv:source");
    expect(sourceSession).toBeDefined();
    expect(compiled.context.resolvedSessions.get("inv:reuse")).toBe(
      sourceSession,
    );
    expect(sourceSession?.effectiveSelection).toEqual(selection);
  });

  it("rejects a fork session with a changed effective selection", async () => {
    const parentSelection: ModelSelection = {
      model: { provider: "openai", model: "gpt-5.6-sol" },
      reasoning: "medium",
    };
    const branchSelection: ModelSelection = {
      model: { provider: "anthropic", model: "claude-sonnet-4-6" },
      reasoning: "high",
    };
    const forkSelections: Array<ModelSelection | undefined> = [];
    const parentSession: ResolvedExecutorSession = {
      key: Symbol("parent"),
      executor: { execute: async () => ({}) },
      effectiveSelection: parentSelection,
      checkpoint: async () => "checkpoint",
      fork: async ({ effectiveSelection }) => {
        forkSelections.push(effectiveSelection);
        return {
          key: Symbol("branch"),
          executor: { execute: async () => ({}) },
          effectiveSelection: parentSelection,
        };
      },
    };
    const compiled = new PlanCompiler().compileWorkflow(
      {
        workflow: { id: "session-selection-branch" },
        nodes: [
          {
            ...task("source"),
            session: { type: "isolated" as const, model: parentSelection },
          },
          {
            ...task("branch", ["source"]),
            session: {
              type: "branch" as const,
              from: "source",
              model: branchSelection,
            },
          },
          {
            ...task("reuse", ["source"]),
            session: { type: "reuse" as const, from: "source" },
          },
          {
            ...task("branch-reuse", ["branch"]),
            session: { type: "reuse" as const, from: "branch" },
          },
        ],
        output: { type: "ref", nodeId: "branch-reuse", path: [] },
      },
      {
        createInvocationId: (nodeId) => `inv:${nodeId}`,
        executors: new Map([["test", parentSession.executor]]),
        sessionResolver: {
          modelCapabilities: {
            executor: "test",
            listModels: async () => [
              parentSelection.model,
              branchSelection.model,
            ],
            resolveDefaultModel: async () => parentSelection,
          },
          resolve: async () => parentSession,
        },
        taskDefinitions: new Map([
          ["source", taskDefinition("source")],
          ["branch", taskDefinition("branch")],
          ["reuse", taskDefinition("reuse")],
          ["branch-reuse", taskDefinition("branch-reuse")],
        ]),
      },
    );

    await preflightCompiledWorkflowModels(compiled);
    await resolveCompiledWorkflowSessions(compiled);
    await expect(runCompiledWorkflow(compiled)).resolves.toMatchObject({
      status: "failed",
      error: { message: expect.stringMatching(/effective model selection/i) },
    });

    const branchSession = compiled.context.resolvedSessions.get("inv:branch");
    expect(forkSelections).toEqual([branchSelection]);
    expect(branchSession).toBeUndefined();
    expect(compiled.context.resolvedSessions.get("inv:source")).toBe(
      parentSession,
    );
    expect(parentSession.effectiveSelection).toEqual(parentSelection);
  });

  it("fails a branch workflow when the source session cannot fork natively", async () => {
    const executor = { execute: async () => ({}) };
    const compiled = new PlanCompiler().compileWorkflow(
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
