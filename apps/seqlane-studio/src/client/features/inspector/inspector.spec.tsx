import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { StudioRunSnapshot } from "@seqlane/studio/protocol";
import { InvocationInspector, UsedSkills, UsedTools } from "./inspector.js";

describe("UsedTools", () => {
  it("deduplicates tool names and displays the latest bounded values", () => {
    const snapshot = {
      summary: {
        workId: "work-1",
        runId: "run-1",
        workflowId: "workflow-1",
        state: "active",
        isIncomplete: false,
        activeInvocationCount: 1,
        lastEventSequence: 4,
      },
      cursor: 4,
      invocations: [
        {
          invocationId: "invocation-1",
          planNodeId: "node-1",
          taskId: "task-1",
          kind: "task",
          label: "Task",
          siblingOrder: 0,
          dependencyIds: [],
          state: "active",
          activities: [
            {
              activityId: "call-1",
              kind: "tool",
              name: "filesystem.read",
              state: "started",
              occurredAt: "2026-08-28T00:00:00.000Z",
            },
            {
              activityId: "call-1",
              kind: "tool",
              name: "filesystem.read",
              state: "succeeded",
              input: { state: "present", value: { path: "/tmp/a" } },
              output: { state: "present", value: { bytes: 12 } },
              occurredAt: "2026-08-28T00:00:01.000Z",
            },
          ],
          output: { persistent: [] },
        },
      ],
    } satisfies StudioRunSnapshot;

    const markup = renderToStaticMarkup(
      <UsedTools
        snapshot={snapshot}
        toolUsage={new Map([["filesystem.read", 7]])}
      />,
    );

    expect(markup).toContain("Used tools");
    expect(markup).toContain("filesystem.read");
    expect(markup).toContain("7 uses");
  });

  it("renders aggregate tools that are no longer in bounded activity history", () => {
    const snapshot = {
      summary: {
        workId: "work-1",
        runId: "run-1",
        workflowId: "workflow-1",
        state: "succeeded",
        isIncomplete: false,
        activeInvocationCount: 0,
        lastEventSequence: 105,
      },
      cursor: 105,
      toolUsage: [{ name: "legacy.tool", count: 1 }],
      invocations: [],
    } satisfies StudioRunSnapshot;

    const markup = renderToStaticMarkup(<UsedTools snapshot={snapshot} />);

    expect(markup).toContain("legacy.tool");
    expect(markup).toContain("1 use");
    expect(markup).toContain("received");
  });

  it("renders skills separately from tools", () => {
    const snapshot = {
      summary: {
        workId: "work-1",
        runId: "run-1",
        workflowId: "workflow-1",
        state: "succeeded",
        isIncomplete: false,
        activeInvocationCount: 0,
        lastEventSequence: 2,
      },
      cursor: 2,
      skillUsage: [{ name: "web-perf", count: 2 }],
      invocations: [],
    } satisfies StudioRunSnapshot;

    const markup = renderToStaticMarkup(<UsedSkills snapshot={snapshot} />);

    expect(markup).toContain("Used skills");
    expect(markup).toContain("web-perf");
    expect(markup).toContain("2 uses");
    expect(markup).not.toContain("Used tools");
  });
});

describe("InvocationInspector", () => {
  it("renders values as flat full-width sections", () => {
    const invocation = {
      invocationId: "invocation-1",
      planNodeId: "node-1",
      taskId: "task-1",
      kind: "task",
      label: "Prepare release",
      siblingOrder: 0,
      dependencyIds: [],
      state: "succeeded",
      input: { state: "present", value: { topic: "Seqlane Studio" } },
      result: { state: "present", value: { complete: true } },
      output: { persistent: [] },
    } satisfies StudioRunSnapshot["invocations"][number];

    const markup = renderToStaticMarkup(
      <InvocationInspector invocation={invocation} />,
    );

    expect(markup).toContain("studio-inspector-section");
    expect(markup).toContain("Input");
    expect(markup).toContain("Seqlane Studio");
    expect(markup).toContain("Result");
    expect(markup).not.toContain("studio-value-card");
  });
});
