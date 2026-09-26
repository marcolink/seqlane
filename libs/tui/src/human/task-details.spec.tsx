// @test-scope ./app.tsx ./tree-row.tsx ./usage.ts ./observation-details.tsx ../run-view-model.ts ../run-activity.ts ../terminal-field.ts ../observation-details.ts
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

it("keeps accumulated summary out of active task details", () => {
  const base = activeView();
  const node = base.nodes.get("live");
  if (!node) throw new Error("Missing test invocation");
  const nodes = new Map(base.nodes);
  nodes.set("live", {
    ...node,
    skillUsage: new Map([["web-perf", 2]]),
  });
  const view = reduceRunViewModel(
    { ...base, nodes },
    {
      ...identity,
      type: "invocation.observation",
      invocationId: "live",
      observationId: "model-1",
      kind: "model",
      state: "succeeded",
      model: {
        provider: "controlled-provider",
        model: "controlled-model",
        request: { text: "input", flags: [false, 0, null] },
        response: { text: "output", structured: { ok: false } },
      },
    },
  );
  const app = render(
    <HumanApp
      view={view}
      capabilities={{ supportsAnsi: false, supportsUnicode: false, width: 200 }}
      spinnerFrame={0}
    />,
  );
  expect(app.lastFrame()).toContain("test-model · shared · delegated");
  expect(app.lastFrame()).not.toContain(
    "model   controlled-provider/controlled-model",
  );
  expect(app.lastFrame()).not.toContain("tokens  input=12400");
  expect(app.lastFrame()).not.toContain("tools   read_file=1");
  expect(app.lastFrame()).not.toContain("skills  web-perf=2");
  expect(app.lastFrame()).not.toContain("model exchanges=");
  expect(app.lastFrame()).not.toContain("state=succeeded");
  expect(app.lastFrame()).not.toContain("attempt=0");
  expect(app.lastFrame()).not.toContain("request=present");
  expect(app.lastFrame()).not.toContain("response=present");
  expect(app.lastFrame()).not.toContain('"provider":"controlled-provider"');
  expect(app.lastFrame()).not.toContain("model observation=");
  expect(app.lastFrame()).not.toContain('"text":"input"');
  expect(app.lastFrame()).not.toContain('"text":"output"');
});

it("shows full task values and completed activity data without redaction", () => {
  let view = activeView();
  view = reduceRunViewModel(view, {
    ...identity,
    type: "invocation.input",
    invocationId: "live",
    input: {
      state: "present",
      value: { token: "classified\u001b[2J\u0085", nested: [1, false] },
    },
  });
  view = reduceRunViewModel(view, {
    ...identity,
    type: "invocation.result",
    invocationId: "live",
    result: {
      state: "present",
      value: { summary: "classified result", facts: { count: 3 } },
    },
  });
  view = reduceRunViewModel(view, {
    ...identity,
    type: "invocation.activity",
    invocationId: "live",
    activityId: "call-1",
    kind: "tool",
    name: "read_file",
    state: "started",
    input: { state: "present", value: { path: "classified/path" } },
    activityMetadata: {
      state: "present",
      value: { requestId: "classified-request" },
    },
  });
  view = reduceRunViewModel(view, {
    ...identity,
    type: "invocation.activity",
    invocationId: "live",
    activityId: "call-1",
    kind: "tool",
    name: "read_file",
    state: "succeeded",
    output: { state: "present", value: { content: "classified output" } },
  });
  view = reduceRunViewModel(view, {
    ...identity,
    type: "invocation.succeeded",
    invocationId: "live",
  });

  const app = render(
    <HumanApp
      view={view}
      capabilities={{
        supportsAnsi: false,
        supportsUnicode: false,
        width: 1_000,
        redactions: ["classified"],
      }}
      spinnerFrame={0}
    />,
  );
  const frame = app.lastFrame() ?? "";

  expect(frame).toContain("classified");
  expect(frame).toContain("classified result");
  expect(frame).toContain("classified/path");
  expect(frame).toContain("classified-request");
  expect(frame).toContain("classified output");
  expect(frame).toContain("\\u001b[2J\\u0085");
  expect(frame).not.toContain("\u001b");
  expect(frame).not.toContain("\u0085");
});
it("shows reported context and aligned usage, preserves wrapped rails, then collapses", async () => {
  const view = activeView();
  const node = view.nodes.get("live");
  if (!node) throw new Error("Missing test invocation");
  const nodes = new Map(view.nodes);
  nodes.set("live", {
    ...node,
    skillUsage: new Map([["web-perf", 2]]),
  });
  const props = {
    capabilities: { supportsAnsi: false, supportsUnicode: true, width: 48 },
    spinnerFrame: 0,
  };
  const app = render(<HumanApp {...props} view={{ ...view, nodes }} />);
  const output = app.lastFrame() ?? "";
  expect(output).toContain("shared");
  expect(output).toContain("delegated");
  expect(output).toContain("test-model");
  expect(output).not.toContain("1 tool calls completed");
  const compactOutput = output.replace(/\s+/g, " ");
  expect(compactOutput).not.toContain("tokens");
  expect(compactOutput).not.toContain("input=12400");
  expect(compactOutput).not.toContain("output=1800");
  expect(compactOutput).not.toContain("tools");
  expect(compactOutput).not.toContain("skills web-perf=2");
  expect(output).not.toContain("Never show raw output");
  const details = output.split("\n").slice(3, -1);
  expect(details.length).toBeGreaterThanOrEqual(3);
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
    expect(app.lastFrame()).toContain("test-model · shared · delegated"),
  );
  const terminalOutput = (app.lastFrame() ?? "").replace(/\s+/g, " ");
  expect(terminalOutput).toContain("14.2k tokens · $0.08");
  expect(terminalOutput).toContain("input 12.4k · output 1.8k · reasoning 0");
  expect(terminalOutput).toContain("cache read 0");
  expect(terminalOutput).toContain("tools read_file×1 · skills none");
  expect(app.lastFrame()).toContain("$0.08");
  expect(app.lastFrame()).toContain("0ms");
});

it("does not add cache tokens to the total token count", () => {
  const base = activeView();
  const node = base.nodes.get("live");
  if (!node) throw new Error("Missing test invocation");
  const view = reduceRunViewModel(
    {
      ...base,
      nodes: new Map(base.nodes).set("live", {
        ...node,
        output: {
          ...node.output,
          metrics: {
            tokens: {
              input: 10,
              output: 5,
              reasoning: 2,
              cacheRead: 100,
              cacheWrite: 3,
            },
          },
        },
      }),
    },
    {
      ...identity,
      type: "invocation.succeeded",
      invocationId: "live",
    },
  );
  const app = render(
    <HumanApp
      view={view}
      capabilities={{ supportsAnsi: false, supportsUnicode: false, width: 120 }}
      spinnerFrame={0}
    />,
  );

  const output = (app.lastFrame() ?? "").replace(/\s+/g, " ");
  expect(output).toContain("17 tokens");
  expect(output).not.toContain("120 tokens");
});

it("replaces live activity lines and removes them from the completed summary", async () => {
  const active = reduceRunViewModel(activeView(), {
    ...tool,
    state: "started",
    message: "opening source file",
  });
  const props = {
    capabilities: { supportsAnsi: false, supportsUnicode: false, width: 100 },
    spinnerFrame: 0,
  };
  const app = render(<HumanApp {...props} view={active} />);
  expect(app.lastFrame()).toContain("[tool] read_file opening source file");
  expect(app.lastFrame()).not.toContain("tokens  input=12400");

  app.rerender(
    <HumanApp
      {...props}
      view={reduceRunViewModel(active, {
        ...identity,
        type: "invocation.succeeded",
        invocationId: "live",
      })}
    />,
  );

  await vi.waitFor(() =>
    expect(app.lastFrame()).not.toContain("[tool] read_file"),
  );
  expect(app.lastFrame()).toContain("14.2k tokens · $0.08");
  expect(app.lastFrame()).toContain("tools read_file×1 · skills none");
});

it("keeps accumulated tokens out of the completed task header", () => {
  const view = reduceRunViewModel(activeView(), {
    ...identity,
    type: "invocation.succeeded",
    invocationId: "live",
  });
  const app = render(
    <HumanApp
      view={view}
      capabilities={{ supportsAnsi: false, supportsUnicode: false, width: 100 }}
      spinnerFrame={0}
    />,
  );
  expect(app.lastFrame()).toContain("14.2k tokens · $0.08");
  const taskLine =
    (app.lastFrame() ?? "")
      .split("\n")
      .find((line) => line.includes("Review runtime")) ?? "";
  expect(taskLine).not.toContain("14.2k tokens");
  expect(app.lastFrame()).not.toContain("1 calls");
});

it("keeps activity usage visible after an activity-only task completes", () => {
  const base = activeView();
  const node = base.nodes.get("live");
  if (!node) throw new Error("Missing test invocation");
  const nodes = new Map(base.nodes);
  nodes.set("live", {
    ...node,
    skillUsage: new Map([["web-perf", 1]]),
  });
  const view = reduceRunViewModel(
    { ...base, nodes },
    {
      ...identity,
      type: "invocation.succeeded",
      invocationId: "live",
    },
  );
  const app = render(
    <HumanApp
      view={view}
      capabilities={{ supportsAnsi: false, supportsUnicode: false, width: 100 }}
      spinnerFrame={0}
    />,
  );
  expect(app.lastFrame()).toContain("14.2k tokens · $0.08");
  expect(app.lastFrame()).toContain("tools read_file×1 · skills web-perf×1");
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

it("renders failed validation identity, verdict, issues, and evidence", () => {
  const view = reduceRunEvents([
    {
      ...identity,
      type: "invocation.created",
      invocationId: "validation",
      planNodeId: "validation.gate:1",
      subject: { type: "validation-gate", planNodeId: "validation.gate:1" },
      kind: "validation",
      label: "Validate release",
      siblingOrder: 0,
      dependencyIds: [],
    },
    {
      ...identity,
      type: "invocation.failed",
      invocationId: "validation",
      disposition: "fail_run",
      error: {
        category: "ValidationError",
        message: "Validation failed",
        validation: {
          validationNodeId: "validation.gate:1",
          sourceId: "release-ready",
          issues: [
            { code: "unsafe", message: "Unsafe result", path: "/release" },
          ],
          evidence: { state: "redacted" },
        },
      },
    },
  ]);
  const app = render(
    <HumanApp
      view={view}
      capabilities={{ supportsAnsi: false, supportsUnicode: true, width: 100 }}
      spinnerFrame={0}
    />,
  );
  const output = app.lastFrame() ?? "";
  const compactOutput = output.replace(/\s+/g, " ");
  expect(output).toContain("validation source=release-ready");
  expect(output).toContain("node=validation.gate:1 verdict=failed");
  expect(compactOutput).toContain("issues=unsafe: Unsafe result @/release");
  expect(output).toContain("evidence=redacted");
});

it("collapses validation details after the task succeeds", async () => {
  const events: SeqlaneExecutionEvent[] = [
    {
      ...identity,
      type: "invocation.created",
      invocationId: "validation",
      planNodeId: "validation.gate:1",
      subject: { type: "validation-gate", planNodeId: "validation.gate:1" },
      kind: "validation",
      label: "Validate release",
      siblingOrder: 0,
      dependencyIds: [],
    },
    {
      ...identity,
      type: "invocation.result",
      invocationId: "validation",
      result: {
        state: "present",
        value: {
          success: true,
          issues: [],
          evidence: { state: "verified" },
        },
      },
    },
  ];
  const view = reduceRunEvents(events);
  const props = {
    capabilities: {
      supportsAnsi: false,
      supportsUnicode: true,
      width: 100,
    },
    spinnerFrame: 0,
  };
  const app = render(<HumanApp {...props} view={view} />);
  expect(app.lastFrame()).toContain("validation source=validation.gate:1");

  app.rerender(
    <HumanApp
      {...props}
      view={reduceRunViewModel(view, {
        ...identity,
        type: "invocation.succeeded",
        invocationId: "validation",
      })}
    />,
  );

  await vi.waitFor(() =>
    expect(app.lastFrame()).not.toContain(
      "validation source=validation.gate:1",
    ),
  );
  expect(app.lastFrame()).toContain("Validate release");
});

it("renders node and run truncation byte counts", () => {
  const view = reduceRunEvents(
    [
      {
        ...identity,
        type: "invocation.created",
        invocationId: "task",
        planNodeId: "task",
        subject: { type: "task", taskId: "task" },
        taskId: "task",
        kind: "task",
        label: "Bounded task",
        siblingOrder: 0,
        dependencyIds: [],
      },
      {
        ...identity,
        type: "invocation.output",
        invocationId: "task",
        policy: "persistent",
        channel: "task",
        content: "😀abcdef",
      },
    ],
    { limits: { nodeDetailBytes: 5, runDetailBytes: 5 } },
  );
  const app = render(
    <HumanApp
      view={view}
      capabilities={{ supportsAnsi: false, supportsUnicode: true, width: 100 }}
      spinnerFrame={0}
    />,
  );
  expect(app.lastFrame()).toContain(
    "[output truncated original_bytes=10 omitted_bytes=5]",
  );
  expect(app.lastFrame()).toContain("details truncated omitted_bytes=5");
});
