// @test-scope ./app.tsx ./tree-row.tsx ./usage.ts ../run-view-model.ts ../run-activity.ts ../terminal-field.ts
import { cleanup, render } from "ink-testing-library";
import { afterEach, expect, it, vi } from "vitest";
import type { SeqlaneExecutionEvent } from "@seqlane/protocol";
import { reduceRunEvents, reduceRunViewModel } from "../run-view-model.js";
import { HumanApp } from "./app.js";

const identity = {
  workId: "work",
  runId: "run",
  metadata: {
    schemaVersion: 1 as const,
    eventId: "event",
    sequence: 1,
    occurredAt: "2026-09-16T00:00:00.000Z",
  },
};
const tool = {
  ...identity,
  type: "invocation.activity",
  invocationId: "live",
  activityId: "call-1",
  kind: "tool",
  name: "read_file",
  state: "succeeded",
} as const;
function activeView() {
  const events: SeqlaneExecutionEvent[] = [
    {
      ...identity,
      type: "run.plan",
      plan: {
        workflow: { id: "Review" },
        nodes: [
          {
            planNodeId: "task",
            type: "task",
            taskId: "task",
            label: "Review runtime",
            siblingOrder: 0,
            dependsOn: [],
            session: {
              type: "isolated",
              model: { model: { provider: "openai", model: "test-model" } },
            },
          },
          {
            planNodeId: "next",
            type: "task",
            taskId: "next",
            label: "Publish",
            siblingOrder: 1,
            dependsOn: ["task"],
          },
        ],
      },
    },
    {
      ...identity,
      type: "invocation.started",
      invocationId: "live",
      subject: { type: "task", taskId: "task" },
    },
    tool,
    { ...tool, state: "progress" },
    tool,
    {
      ...identity,
      type: "invocation.progress",
      invocationId: "live",
      state: "active",
      phase: "execution",
      message:
        "Reading a long source path that wraps onto several terminal lines",
      workspace: "shared",
    },
    {
      ...identity,
      type: "invocation.output",
      invocationId: "live",
      policy: "transient",
      channel: "task",
      content: "Never show raw output",
      metrics: {
        tokens: {
          input: 12400,
          output: 1800,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        cost: 0.08,
      },
    },
  ];
  return reduceRunEvents(events, {
    now: () => new Date("2026-09-16T00:00:00Z"),
  });
}
afterEach(cleanup);
it("encodes and redacts all dynamic human fields", () => {
  const view = activeView();
  const node = view.nodes.get("live");
  if (!node) throw new Error("Missing test invocation");
  const dangerous = "secret\u001b[2J\r\n\u0085\u202e";
  const nodes = new Map(view.nodes);
  nodes.set("live", {
    ...node,
    label: dangerous,
    activity: dangerous,
    output: { ...node.output, metrics: { model: dangerous } },
  });
  const app = render(
    <HumanApp
      view={{
        ...view,
        nodes,
        workflowLabel: dangerous,
        runError: { category: "ExecutorError", message: dangerous },
      }}
      capabilities={{
        supportsAnsi: false,
        supportsUnicode: true,
        width: 80,
        redactions: ["secret"],
      }}
      spinnerFrame={0}
    />,
  );
  const frame = app.lastFrame() ?? "";
  expect(frame).not.toContain("secret");
  for (const control of ["\u001b", "\r", "\u0085", "\u202e"])
    expect(frame).not.toContain(control);
  expect(frame).toContain("***\\u000d\\u000a");
});
it("shows reported context and usage, preserves wrapped rails, then collapses", async () => {
  const view = activeView();
  const props = {
    capabilities: { supportsAnsi: false, supportsUnicode: true, width: 48 },
    spinnerFrame: 0,
  };
  const app = render(<HumanApp {...props} view={view} />);
  const output = app.lastFrame() ?? "";
  expect(output).toContain("workspace shared");
  expect(output).toContain("session new (planned)");
  expect(output).toContain("test-model");
  expect(output).toContain("1 tool calls completed");
  expect(output).toContain("in 12400");
  expect(output).toContain("1800");
  expect(output).toContain("$0.08");
  expect(output).not.toContain("Never show raw output");
  const details = output.split("\n").slice(3, -1);
  expect(details.length).toBeGreaterThan(3);
  expect(details.every((line) => line.startsWith("│"))).toBe(true);
  expect(output).toMatchSnapshot();
  app.rerender(
    <HumanApp
      {...props}
      view={reduceRunViewModel(view, {
        ...identity,
        type: "invocation.succeeded",
        invocationId: "live",
      })}
    />,
  );
  await vi.waitFor(() =>
    expect(app.lastFrame()).not.toContain("workspace shared"),
  );
  expect(app.lastFrame()).toContain("$0.08");
  expect(app.lastFrame()).toContain("0ms");
});
it("does not invent metrics or workspace context", () => {
  const view = activeView();
  const node = view.nodes.get("live");
  if (!node) throw new Error("Missing test invocation");
  const nodes = new Map(view.nodes);
  nodes.set("live", {
    ...node,
    workspace: undefined,
    session: undefined,
    output: { persistent: [] },
    completedToolIds: undefined,
  });
  const app = render(
    <HumanApp
      view={{ ...view, nodes }}
      capabilities={{ supportsAnsi: false, supportsUnicode: false, width: 60 }}
      spinnerFrame={0}
    />,
  );
  expect(app.lastFrame()).not.toMatch(
    /workspace|session|\$|tool calls|in 12400/,
  );
});
