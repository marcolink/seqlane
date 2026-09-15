import type { SeqlaneExecutionEvent } from "@seqlane/protocol";
import { describe, expect, it } from "vitest";
import {
  collapseOrFocusParent,
  expandOrFocusChild,
  focusNextFailedRunNode,
  getRunProjectionLimitNotice,
  getRunViewportRows,
  getRunVisibleRows,
  moveRunNodeFocus,
  reduceRunEvents,
  setRunNodeExpanded,
  setRunNodeFocused,
} from "./run-view-model.js";

const run = {
  workId: "work-1",
  runId: "run-1",
  metadata: {
    schemaVersion: 1 as const,
    eventId: "test-event",
    sequence: 1,
    occurredAt: "2026-08-18T00:00:00.000Z",
  },
};

function created(
  invocationId: string,
  label: string,
  siblingOrder: number,
  options: {
    kind?: "workflow" | "loop" | "task";
    parentInvocationId?: string;
    dependencyIds?: readonly string[];
    iteration?: number;
  } = {},
): SeqlaneExecutionEvent {
  return {
    type: "invocation.created",
    ...run,
    invocationId,
    planNodeId: invocationId,
    subject: { type: "task", taskId: label },
    taskId: label,
    kind: options.kind ?? "task",
    label,
    siblingOrder,
    dependencyIds: options.dependencyIds ?? [],
    ...(options.parentInvocationId === undefined
      ? {}
      : { parentInvocationId: options.parentInvocationId }),
    ...(options.iteration === undefined
      ? {}
      : { iteration: options.iteration }),
  };
}

function started(invocationId: string, taskId: string): SeqlaneExecutionEvent {
  return {
    type: "invocation.started",
    ...run,
    invocationId,
    subject: { type: "task", taskId },
    taskId,
  };
}

function terminal(
  invocationId: string,
  type: "invocation.succeeded" | "invocation.cancelled",
): SeqlaneExecutionEvent {
  return { type, ...run, invocationId };
}

describe("human execution view model", () => {
  it("keeps the focused row in a derived viewport without changing focus", () => {
    let view = reduceRunEvents(
      Array.from({ length: 8 }, (_, index) =>
        created(`task-${index}`, `Task ${index}`, index),
      ),
    );
    view = setRunNodeFocused(view, "task-6");

    expect(
      getRunViewportRows(view, 3).map((row) => row.node.invocationId),
    ).toContain("task-6");
    expect(view.presentation.get("task-6")?.isFocused).toBe(true);
  });

  it("bounds nodes, dependency edges, and detail text with visible markers", () => {
    const events = [
      created("root", "Root", 0, {
        kind: "workflow",
        dependencyIds: ["a", "b"],
      }),
      created("omitted", "Omitted", 1),
      {
        type: "invocation.output" as const,
        ...run,
        invocationId: "root",
        policy: "persistent" as const,
        channel: "task" as const,
        content: "😀 a payload that cannot fit",
      },
    ];
    const view = reduceRunEvents(events, {
      limits: {
        nodes: 1,
        dependencyEdges: 1,
        nodeDetailBytes: 8,
        runDetailBytes: 8,
      },
    });

    expect(view.nodes.size).toBe(1);
    expect(view.nodes.get("root")?.dependencyIds).toEqual(["a"]);
    expect(getRunProjectionLimitNotice(view)).toContain("nodes=1 edges=1");
    expect(view.nodes.get("root")?.output.persistent[0]).toContain(
      "[truncated original_bytes=",
    );
  });

  it("keeps presentation state separate from execution nodes", () => {
    const view = reduceRunEvents([
      created("workflow", "Workflow", 0, { kind: "workflow" }),
      created("task", "Task", 0, { parentInvocationId: "workflow" }),
    ]);
    const executionNode = view.nodes.get("workflow");

    expect(executionNode).toBeDefined();
    expect(executionNode).not.toHaveProperty("presentation");
    expect(view.presentation.get("workflow")).toEqual({
      isExpanded: true,
      isFocused: false,
    });

    const collapsed = setRunNodeExpanded(view, "workflow", false);
    const focused = setRunNodeFocused(collapsed, "task");
    expect(focused.nodes.get("workflow")).toBe(executionNode);
    expect(focused.presentation.get("workflow")).toEqual({
      isExpanded: false,
      isFocused: false,
      isManuallyExpanded: true,
    });
    expect(focused.presentation.get("task")).toEqual({
      isExpanded: false,
      isFocused: true,
    });
  });

  it("creates stable rows before execution starts", () => {
    const view = reduceRunEvents([
      created("root", "Root", 0, { kind: "workflow" }),
      created("child", "Child", 0, {
        kind: "workflow",
        parentInvocationId: "root",
      }),
      created("task-a", "Task A", 0, { parentInvocationId: "child" }),
    ]);

    expect([...view.nodes.keys()]).toEqual(["root", "child", "task-a"]);
    expect(getRunVisibleRows(view).map(({ node }) => node.label)).toEqual([
      "Root",
      "Child",
      "Task A",
    ]);
  });

  it("keeps nested containment separate from dependencies", () => {
    const view = reduceRunEvents([
      created("root", "Root", 0, { kind: "workflow" }),
      created("left", "Left", 0, { parentInvocationId: "root" }),
      created("right", "Right", 1, {
        parentInvocationId: "root",
        dependencyIds: ["left"],
      }),
    ]);

    const rows = getRunVisibleRows(view);
    expect(rows.map(({ node, depth }) => [node.invocationId, depth])).toEqual([
      ["root", 0],
      ["left", 1],
      ["right", 1],
    ]);
    expect(view.nodes.get("right")?.parentInvocationId).toBe("root");
    expect(view.nodes.get("right")?.dependencyIds).toEqual(["left"]);
  });

  it("preserves sibling order when parallel events arrive interleaved", () => {
    const view = reduceRunEvents([
      created("a", "A", 0),
      created("b", "B", 1),
      started("b", "B"),
      started("a", "A"),
    ]);

    expect(
      getRunVisibleRows(view).map(({ node }) => node.invocationId),
    ).toEqual(["a", "b"]);
    expect(view.nodes.get("a")?.state).toBe("active");
    expect(view.nodes.get("b")?.state).toBe("active");
  });

  it("projects a deep visible tree without consuming the call stack", () => {
    const events: SeqlaneExecutionEvent[] = [];
    for (let index = 0; index < 1_200; index += 1) {
      events.push(
        created(`node-${index}`, `Node ${index}`, 0, {
          kind: "workflow",
          ...(index === 0 ? {} : { parentInvocationId: `node-${index - 1}` }),
        }),
      );
    }

    const rows = getRunVisibleRows(reduceRunEvents(events));
    expect(rows).toHaveLength(1_200);
    expect(rows.at(-1)?.depth).toBe(1_199);
  });

  it("navigates visible rows and reveals a failed branch", () => {
    const view = reduceRunEvents([
      created("root", "Root", 0, { kind: "workflow" }),
      created("left", "Left", 0, { parentInvocationId: "root" }),
      created("right", "Right", 1, { parentInvocationId: "root" }),
      {
        type: "invocation.failed",
        ...run,
        invocationId: "right",
        disposition: "fail_run",
        error: { category: "ExecutorError", message: "failed" },
      },
    ]);

    const focused = setRunNodeFocused(view, "root");
    expect(
      moveRunNodeFocus(focused, 1).presentation.get("left")?.isFocused,
    ).toBe(true);
    expect(
      collapseOrFocusParent(focused).presentation.get("root")?.isExpanded,
    ).toBe(false);
    expect(
      expandOrFocusChild(collapseOrFocusParent(focused)).presentation.get(
        "root",
      )?.isExpanded,
    ).toBe(true);

    const failed = focusNextFailedRunNode(
      setRunNodeExpanded(focused, "root", false),
    );
    expect(failed.presentation.get("root")?.isExpanded).toBe(true);
    expect(failed.presentation.get("right")?.isFocused).toBe(true);
  });

  it("keeps loop children grouped by iteration in stable order", () => {
    const view = reduceRunEvents([
      created("loop", "repeat:1", 0, { kind: "loop" }),
      created("iteration-2-b", "Body B", 3, {
        kind: "task",
        parentInvocationId: "loop",
        iteration: 2,
      }),
      created("iteration-1-a", "Body A", 0, {
        parentInvocationId: "loop",
        iteration: 1,
      }),
      created("iteration-2-a", "Body A", 2, {
        parentInvocationId: "loop",
        iteration: 2,
      }),
      created("iteration-1-b", "Body B", 1, {
        parentInvocationId: "loop",
        iteration: 1,
      }),
    ]);

    expect(
      getRunVisibleRows(view).map(({ node }) => node.invocationId),
    ).toEqual([
      "loop",
      "iteration-1-a",
      "iteration-1-b",
      "iteration-2-a",
      "iteration-2-b",
    ]);
    expect(view.nodes.get("iteration-2-a")).toMatchObject({
      parentInvocationId: "loop",
      iteration: 2,
    });
  });

  it("explains dependency waiting with labels", () => {
    const view = reduceRunEvents([
      created("a", "Prepare", 0),
      created("b", "Build", 1, { dependencyIds: ["a", "missing"] }),
      {
        type: "invocation.progress",
        ...run,
        invocationId: "b",
        state: "waiting",
        phase: "dependencies",
        waitingReason: "Waiting for prerequisites",
        dependencyIds: ["a", "missing"],
      },
    ]);

    expect(view.nodes.get("b")).toMatchObject({
      state: "waiting",
      waitingReason: "Waiting for prerequisites",
      waitingDependencyLabels: ["Prepare"],
    });
  });

  it("aggregates completed descendants and supports collapse", () => {
    const expanded = reduceRunEvents([
      created("workflow", "Workflow", 0, { kind: "workflow" }),
      created("a", "A", 0, { parentInvocationId: "workflow" }),
      created("b", "B", 1, { parentInvocationId: "workflow" }),
      started("a", "A"),
      terminal("a", "invocation.succeeded"),
      started("b", "B"),
      terminal("b", "invocation.succeeded"),
    ]);
    const workflow = expanded.nodes.get("workflow");
    expect(workflow?.aggregate).toMatchObject({
      total: 2,
      succeeded: 2,
      failed: 0,
    });

    const collapsed = setRunNodeExpanded(expanded, "workflow", false);
    expect(getRunVisibleRows(collapsed).map(({ node }) => node.label)).toEqual([
      "Workflow",
    ]);
  });

  it("keeps an invocation succeeded after workspace release progress", () => {
    const view = reduceRunEvents([
      created("task", "Task", 0),
      started("task", "Task"),
      terminal("task", "invocation.succeeded"),
      {
        type: "invocation.progress",
        ...run,
        invocationId: "task",
        state: "active",
        phase: "workspace_released",
        workspace: "exclusive",
      },
    ]);

    expect(view.nodes.get("task")?.state).toBe("succeeded");
  });

  it("keeps sibling state unchanged when one task fails", () => {
    const view = reduceRunEvents([
      created("a", "A", 0),
      created("b", "B", 1),
      started("a", "A"),
      started("b", "B"),
      {
        type: "invocation.failed",
        ...run,
        invocationId: "a",
        disposition: "continue_siblings",
        error: { category: "ExecutorError", message: "redacted failure" },
      },
    ]);

    expect(view.nodes.get("a")).toMatchObject({
      state: "failed",
      failure: {
        message: "redacted failure",
        disposition: "continue_siblings",
      },
      continuationReason: "Execution continued after this failure",
    });
    expect(view.nodes.get("b")?.state).toBe("active");
  });

  it("retains retry state and persistent output", () => {
    const view = reduceRunEvents([
      created("a", "A", 0),
      started("a", "A"),
      {
        type: "invocation.output",
        ...run,
        invocationId: "a",
        policy: "transient",
        channel: "task",
        content: "working",
      },
      {
        type: "invocation.output",
        ...run,
        invocationId: "a",
        policy: "persistent",
        channel: "task",
        content: "checkpoint saved",
      },
      {
        type: "invocation.retrying",
        ...run,
        invocationId: "a",
        attempt: 2,
        maximumAttempts: 3,
        delayMs: 1000,
        nextAttemptAt: "2026-08-18T00:00:01.000Z",
        lastError: { category: "ExecutorError", message: "last failure" },
      },
    ]);

    expect(view.nodes.get("a")).toMatchObject({
      state: "retrying",
      output: { transient: "working", persistent: ["checkpoint saved"] },
      retry: {
        attempt: 2,
        maximumAttempts: 3,
        nextAttemptAt: "2026-08-18T00:00:01.000Z",
      },
    });
  });

  it("retains output summaries and execution metrics", () => {
    const view = reduceRunEvents([
      created("a", "A", 0),
      {
        type: "invocation.output",
        ...run,
        invocationId: "a",
        policy: "persistent",
        channel: "task",
        content: "Task completed",
        metrics: {
          durationMs: 1250,
          model: "fake-model",
          provider: "fake-provider",
          cost: 0.0042,
          tokens: {
            total: 42,
            input: 20,
            output: 12,
            reasoning: 8,
            cacheRead: 2,
            cacheWrite: 0,
          },
        },
        summary: { kind: "object", size: 2, fields: ["files", "summary"] },
      },
    ]);

    expect(view.nodes.get("a")?.output).toMatchObject({
      metrics: { model: "fake-model", tokens: { total: 42 } },
      summary: { kind: "object", size: 2, fields: ["files", "summary"] },
    });
  });

  it("preserves skip and cancellation reasons", () => {
    const view = reduceRunEvents([
      created("a", "A", 0),
      created("b", "B", 1),
      {
        type: "invocation.skipped",
        ...run,
        invocationId: "b",
        reason: "dependency A failed",
        dependencyIds: ["a"],
      },
      {
        type: "invocation.cancelled",
        ...run,
        invocationId: "a",
        reason: "cancelled by policy",
      },
    ]);

    expect(view.nodes.get("b")).toMatchObject({
      state: "skipped",
      skipReason: "dependency A failed",
    });
    expect(view.nodes.get("a")).toMatchObject({
      state: "cancelled",
      skipReason: "cancelled by policy",
    });
  });

  it("updates labels without changing row identity or order", () => {
    const view = reduceRunEvents([
      created("a", "Initial label", 0),
      created("b", "Second", 1),
      {
        type: "invocation.progress",
        ...run,
        invocationId: "a",
        state: "active",
        phase: "execute",
        label: "Updated label",
      },
    ]);

    expect(view.nodes.get("a")?.label).toBe("Updated label");
    expect(
      getRunVisibleRows(view).map(({ node }) => node.invocationId),
    ).toEqual(["a", "b"]);
  });

  it("uses event timestamps for deterministic elapsed time", () => {
    const view = reduceRunEvents([
      {
        ...created("a", "A", 0),
        metadata: {
          schemaVersion: 1,
          eventId: "1",
          sequence: 1,
          occurredAt: "2026-08-18T00:00:00.000Z",
        },
      },
      {
        ...started("a", "A"),
        metadata: {
          schemaVersion: 1,
          eventId: "2",
          sequence: 2,
          occurredAt: "2026-08-18T00:00:01.000Z",
        },
      },
      {
        ...terminal("a", "invocation.succeeded"),
        metadata: {
          schemaVersion: 1,
          eventId: "3",
          sequence: 3,
          occurredAt: "2026-08-18T00:00:04.000Z",
        },
      },
    ]);

    expect(view.nodes.get("a")?.elapsedMs).toBe(3000);
  });

  it("projects a failed repeat postcondition without failing its invocation", () => {
    const view = reduceRunEvents([
      {
        type: "invocation.created",
        ...run,
        invocationId: "validation-gate",
        planNodeId: "repeat:1/validation.gate:1",
        subject: {
          type: "validation-gate",
          planNodeId: "repeat:1/validation.gate:1",
        },
        kind: "validation",
        label: "Repeat postcondition",
        siblingOrder: 0,
        dependencyIds: [],
      },
      {
        type: "invocation.result",
        ...run,
        invocationId: "validation-gate",
        result: {
          state: "present",
          value: {
            success: false,
            issues: [
              {
                code: "missing-summary",
                message: "Summary is missing",
                path: "/summary",
              },
            ],
            evidence: { summary: null },
          },
        },
      },
      {
        type: "invocation.succeeded",
        ...run,
        invocationId: "validation-gate",
      },
    ]);

    expect(view.nodes.get("validation-gate")).toMatchObject({
      state: "succeeded",
      validation: {
        validationNodeId: "repeat:1/validation.gate:1",
        sourceId: "repeat:1/validation.gate:1",
        sourceType: "validation-gate",
        verdict: "failed",
        continued: true,
        issues: [{ code: "missing-summary" }],
        evidence: { state: "present", value: { summary: null } },
      },
    });
  });

  it.each([
    { success: false, issues: [] },
    { success: false, issues: [{ code: 42, message: "not a string" }] },
  ])("ignores malformed validation results", (value) => {
    const view = reduceRunEvents([
      {
        type: "invocation.created",
        ...run,
        invocationId: "validation-gate",
        planNodeId: "validation.gate:1",
        subject: { type: "validation-gate", planNodeId: "validation.gate:1" },
        kind: "validation",
        label: "Validate result",
        siblingOrder: 0,
        dependencyIds: [],
      },
      {
        type: "invocation.result",
        ...run,
        invocationId: "validation-gate",
        result: { state: "present", value },
      } as never,
    ]);

    expect(view.nodes.get("validation-gate")?.validation).toMatchObject({
      verdict: "unknown",
      issues: [],
      continued: false,
    });
  });

  it("projects normal gate failure details and bounded evidence", () => {
    const view = reduceRunEvents([
      {
        type: "invocation.created",
        ...run,
        invocationId: "validation-gate",
        planNodeId: "validation.gate:1",
        subject: { type: "validation-gate", planNodeId: "validation.gate:1" },
        kind: "validation",
        label: "Validate result",
        siblingOrder: 0,
        dependencyIds: [],
      },
      {
        type: "invocation.failed",
        ...run,
        invocationId: "validation-gate",
        disposition: "fail_run",
        error: {
          category: "ValidationError",
          message: "Validation failed",
          validation: {
            validationNodeId: "validation.gate:1",
            sourceId: "release-ready",
            issues: [{ code: "unsafe", message: "Unsafe result" }],
            evidence: { state: "redacted", summary: { kind: "object" } },
          },
        },
      },
    ]);

    expect(view.nodes.get("validation-gate")).toMatchObject({
      state: "failed",
      validation: {
        validationNodeId: "validation.gate:1",
        sourceId: "release-ready",
        verdict: "failed",
        continued: false,
        evidence: { state: "redacted" },
      },
    });
  });

  it("shows the latest tool activity on its invocation row", () => {
    const view = reduceRunEvents([
      created("a", "A", 0),
      {
        type: "invocation.activity",
        ...run,
        invocationId: "a",
        activityId: "call-1",
        kind: "tool",
        name: "filesystem.read",
        state: "started",
      },
      {
        type: "invocation.activity",
        ...run,
        invocationId: "a",
        activityId: "call-1",
        kind: "tool",
        name: "filesystem.read",
        state: "succeeded",
      },
    ]);

    expect(view.nodes.get("a")?.activity).toBe(
      "tool filesystem.read succeeded",
    );
    expect([...(view.nodes.get("a")?.toolUsage.entries() ?? [])]).toEqual([
      ["filesystem.read", 2],
    ]);
    expect([...view.toolUsage.entries()]).toEqual([["filesystem.read", 2]]);
  });

  it("keeps skill usage separate from tool usage", () => {
    const view = reduceRunEvents([
      created("a", "A", 0),
      {
        type: "invocation.activity",
        ...run,
        invocationId: "a",
        activityId: "skill-1",
        kind: "skill",
        name: "web-perf",
        state: "succeeded",
      },
    ]);

    expect(view.nodes.get("a")?.activity).toBe("skill web-perf succeeded");
    expect([...view.nodes.get("a")!.skillUsage.entries()]).toEqual([
      ["web-perf", 1],
    ]);
    expect([...view.skillUsage.entries()]).toEqual([["web-perf", 1]]);
    expect(view.toolUsage.size).toBe(0);
  });
});
