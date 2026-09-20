// @test-scope ./app.tsx ./header.tsx ./tree.tsx ./tree-row.tsx ./format.ts ./theme.ts
import { cleanup, render } from "ink-testing-library";
import { stripVTControlCharacters } from "node:util";
import type { SeqlaneExecutionEvent } from "@seqlane/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getRunVisibleRows,
  reduceRunEvents,
  reduceRunViewModel,
} from "../run-view-model.js";
import { HumanApp, LiveHumanApp } from "./app.js";
import { sameHumanTreeRowProps } from "./tree-row.js";

const event = {
  workId: "work-1",
  runId: "run-1",
  metadata: {
    schemaVersion: 1 as const,
    eventId: "event-1",
    sequence: 1,
    occurredAt: "2026-09-15T00:00:00.000Z",
  },
};

function getOnlyRow(view: ReturnType<typeof reduceRunEvents>) {
  const row = getRunVisibleRows(view)[0];
  if (row === undefined) throw new Error("expected one visible row");
  return row;
}

describe("HumanApp", () => {
  afterEach(cleanup);
  it.each([
    [40, 1, "1ms"],
    [80, 0, "0ms"],
    [100, 11000, "11.0s"],
    [101, 11000, "11.0s"],
  ] as const)(
    "preserves duration units at the terminal edge (%i columns)",
    async (width, elapsed, expected) => {
      const occurredAt = new Date(
        Date.parse(event.metadata.occurredAt) + elapsed,
      ).toISOString();
      const view = reduceRunEvents([
        { type: "run.started", ...event },
        {
          type: "invocation.created",
          ...event,
          invocationId: "timed",
          planNodeId: "timed",
          subject: { type: "task", taskId: "timed" },
          taskId: "timed",
          kind: "task",
          label: "Timed task",
          siblingOrder: 0,
          dependencyIds: [],
        },
        {
          type: "invocation.started",
          ...event,
          invocationId: "timed",
          subject: { type: "task", taskId: "timed" },
        },
        {
          type: "invocation.succeeded",
          ...event,
          invocationId: "timed",
          metadata: {
            ...event.metadata,
            occurredAt,
          },
        },
        {
          type: "run.succeeded",
          ...event,
          output: null,
          metadata: {
            ...event.metadata,
            occurredAt,
          },
        },
      ]);
      const rendered = render(
        <HumanApp
          view={view}
          capabilities={{ supportsAnsi: true, supportsUnicode: true, width }}
          spinnerFrame={0}
        />,
      );
      vi.spyOn(rendered.stdout, "columns", "get").mockReturnValue(width);
      rendered.stdout.emit("resize");
      await vi.waitFor(() => {
        const lines = (rendered.lastFrame() ?? "").split("\n");
        expect(lines[0]).toContain(expected);
        expect(lines.slice(2).some((line) => line.includes(expected))).toBe(
          true,
        );
        // Visible text must stop before the terminal's last column.
        expect(
          lines.every((line) => stripVTControlCharacters(line).length < width),
        ).toBe(true);
      });
    },
  );
  it("renders four containment levels with stable branch rails", () => {
    const definitions = [
      ["review", undefined, "Review changes", "workflow"],
      ["runtime", "review", "Runtime package", "workflow"],
      ["checks", "runtime", "Checks", "workflow"],
      ["test", "checks", "Run integration tests", "task"],
      ["publish", undefined, "Publish report", "task"],
    ] as const;
    const events: SeqlaneExecutionEvent[] = definitions.map(
      ([id, parent, label, kind], index) => ({
        type: "invocation.created",
        ...event,
        invocationId: id,
        planNodeId: id,
        subject: { type: "task", taskId: id },
        taskId: id,
        label,
        kind,
        parentInvocationId: parent,
        siblingOrder: index,
        dependencyIds: [],
      }),
    );
    const view = reduceRunEvents(events, {
      now: () => new Date(event.metadata.occurredAt),
    });
    const rendered = render(
      <HumanApp
        view={view}
        capabilities={{ supportsAnsi: false, supportsUnicode: true, width: 80 }}
        spinnerFrame={0}
      />,
    );
    expect(rendered.lastFrame()).toContain("├─ ○ ▼ Review changes");
    expect(rendered.lastFrame()).toContain(
      "│        └─ ○ Run integration tests",
    );
    expect(rendered.lastFrame()).toContain("└─ ○ Publish report");
    expect(rendered.lastFrame()).toMatchSnapshot();
  });

  it("uses Ink animation and releases it when the run finishes", async () => {
    const props = {
      view: reduceRunEvents([{ type: "run.started", ...event }]),
      capabilities: { supportsAnsi: false, supportsUnicode: true },
      spinnerFrame: 0,
    };
    const rendered = render(<LiveHumanApp {...props} />);
    const initial = rendered.lastFrame();
    await vi.waitFor(() => expect(rendered.lastFrame()).not.toBe(initial));
    rendered.rerender(
      <LiveHumanApp
        {...props}
        view={reduceRunViewModel(props.view, {
          type: "run.succeeded",
          output: null,
          ...event,
        })}
      />,
    );
    await vi.waitFor(() => expect(rendered.lastFrame()).toContain("✓"));
    rendered.unmount();
    const framesAfterUnmount = rendered.frames.length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(rendered.frames).toHaveLength(framesAfterUnmount);
    expect(rendered.stdin.listenerCount("data")).toBe(0);
  });

  it("updates an active task duration without receiving another event", async () => {
    let currentTime = Date.parse(event.metadata.occurredAt);
    const view = reduceRunEvents(
      [
        { type: "run.started", ...event },
        {
          type: "invocation.created",
          ...event,
          invocationId: "task-1",
          planNodeId: "task-1",
          subject: { type: "task", taskId: "task-1" },
          taskId: "task-1",
          kind: "task",
          label: "Long task",
          siblingOrder: 0,
          dependencyIds: [],
        },
        {
          type: "invocation.started",
          ...event,
          invocationId: "task-1",
          subject: { type: "task", taskId: "task-1" },
        },
      ],
      { now: () => new Date(currentTime) },
    );
    const rendered = render(
      <HumanApp
        view={view}
        capabilities={{ supportsAnsi: false, supportsUnicode: true, width: 80 }}
        spinnerFrame={0}
        animate
      />,
    );

    expect((rendered.lastFrame() ?? "").split("\n")[2]).toContain("0ms");
    currentTime += 1_100;
    await vi.waitFor(() =>
      expect((rendered.lastFrame() ?? "").split("\n")[2]).toContain("1.1s"),
    );
  });

  it("renders a passive tree without session links, controls, or run IDs", () => {
    const view = reduceRunEvents(
      [
        { type: "run.started", ...event },
        {
          type: "invocation.created",
          ...event,
          invocationId: "task-1",
          planNodeId: "task-1",
          subject: { type: "task", taskId: "task" },
          taskId: "task",
          kind: "task",
          label: "Build release",
          siblingOrder: 0,
          dependencyIds: [],
        },
      ] satisfies SeqlaneExecutionEvent[],
      {
        now: () => new Date("2026-09-15T00:00:00.000Z"),
      },
    );

    const rendered = render(
      <HumanApp
        view={view}
        capabilities={{ supportsAnsi: false, supportsUnicode: false }}
        spinnerFrame={0}
      />,
    );

    const output = rendered.lastFrame() ?? "";
    expect(output).toContain("Seqlane run");
    expect(output).toContain("Build release");
    expect(output).not.toContain("Session UI:");
    expect(output.split("\n")).toHaveLength(3);
    expect(output).not.toContain("help");
    expect(output).not.toContain("work=");
    expect(output).not.toContain("run=");
    expect(output).toContain("0/1");
    rendered.stdin.write("j?\\r");
    expect(rendered.lastFrame()).toBe(output);
  });

  it("keeps the exact planned task total when projection omits rows", () => {
    const view = reduceRunEvents(
      [
        {
          type: "run.plan",
          ...event,
          plan: {
            workflow: { id: "large" },
            nodes: Array.from({ length: 6 }, (_, index) => ({
              planNodeId: String(index),
              type: "task" as const,
              taskId: String(index),
              label: `Task ${index}`,
              siblingOrder: index,
              dependsOn: [],
            })),
          },
        },
      ],
      { limits: { nodes: 2 } },
    );
    const rendered = render(
      <HumanApp
        view={view}
        capabilities={{ supportsAnsi: false, supportsUnicode: true, width: 80 }}
        spinnerFrame={0}
      />,
    );
    expect(rendered.lastFrame()).toContain("≥0/6");
    expect(rendered.lastFrame()).toContain("omitted nodes=4");
  });

  it("does not color the projection notice when ANSI is disabled", () => {
    const view = reduceRunEvents(
      [
        {
          type: "run.plan",
          ...event,
          plan: {
            workflow: { id: "bounded" },
            nodes: ["retained", "omitted"].map((id, index) => ({
              planNodeId: id,
              type: "task" as const,
              taskId: id,
              label: id,
              siblingOrder: index,
              dependsOn: [],
            })),
          },
        },
      ],
      { limits: { nodes: 1 } },
    );
    const rendered = render(
      <HumanApp
        view={view}
        capabilities={{ supportsAnsi: false, supportsUnicode: true, width: 80 }}
        spinnerFrame={0}
      />,
    );
    const frame = rendered.lastFrame() ?? "";
    expect(frame).toContain("projection limit");
    expect(frame).toBe(stripVTControlCharacters(frame));
  });

  it("keeps omitted task completion counts as an explicit lower bound", () => {
    let view = reduceRunEvents(
      [
        {
          type: "run.plan",
          ...event,
          plan: {
            workflow: { id: "bounded" },
            nodes: ["retained", "omitted"].map((id, index) => ({
              planNodeId: id,
              type: "task" as const,
              taskId: id,
              label: id,
              siblingOrder: index,
              dependsOn: [],
            })),
          },
        },
      ],
      { limits: { nodes: 1 } },
    );
    view = reduceRunViewModel(view, {
      type: "invocation.created",
      ...event,
      invocationId: "live-omitted",
      planNodeId: "omitted",
      subject: { type: "task", taskId: "omitted" },
      taskId: "omitted",
      kind: "task",
      label: "omitted",
      siblingOrder: 1,
      dependencyIds: [],
    });
    view = reduceRunViewModel(view, {
      type: "invocation.succeeded",
      ...event,
      invocationId: "live-omitted",
    });
    const rendered = render(
      <HumanApp
        view={view}
        capabilities={{
          supportsAnsi: false,
          supportsUnicode: false,
          width: 80,
        }}
        spinnerFrame={0}
      />,
    );
    expect(rendered.lastFrame()).toContain(">=0/2");
    expect(rendered.lastFrame()).not.toContain("1/2");
  });

  it("adds dynamic tasks to planned header totals", () => {
    let view = reduceRunEvents([
      {
        type: "run.plan",
        ...event,
        plan: {
          workflow: { id: "dynamic" },
          nodes: [
            {
              planNodeId: "planned",
              type: "task",
              taskId: "planned",
              label: "Planned",
              siblingOrder: 0,
              dependsOn: [],
            },
          ],
        },
      },
      {
        type: "invocation.created",
        ...event,
        invocationId: "dynamic",
        planNodeId: "dynamic",
        subject: { type: "task", taskId: "dynamic" },
        taskId: "dynamic",
        kind: "task",
        label: "Dynamic",
        siblingOrder: 1,
        dependencyIds: [],
      },
    ]);
    view = reduceRunViewModel(view, {
      type: "invocation.succeeded",
      ...event,
      invocationId: "dynamic",
    });
    const rendered = render(
      <HumanApp
        view={view}
        capabilities={{ supportsAnsi: false, supportsUnicode: true, width: 80 }}
        spinnerFrame={0}
      />,
    );
    expect(rendered.lastFrame()).toContain("1/2");
    expect(rendered.lastFrame()).not.toContain("1/1");
  });

  it("memoizes stable non-active rows across spinner frames", () => {
    const view = reduceRunEvents([
      {
        type: "invocation.created",
        ...event,
        invocationId: "queued",
        planNodeId: "queued",
        subject: { type: "task", taskId: "queued" },
        taskId: "queued",
        kind: "task",
        label: "Queued",
        siblingOrder: 0,
        dependencyIds: [],
      },
    ]);
    const row = getOnlyRow(view);
    const common = {
      row,
      capabilities: { supportsAnsi: false, supportsUnicode: true },
      lastSibling: true,
      now: view.now,
    };
    expect(
      sameHumanTreeRowProps(
        { ...common, spinnerFrame: 0 },
        { ...common, spinnerFrame: 1 },
      ),
    ).toBe(true);

    const active = reduceRunViewModel(view, {
      type: "invocation.started",
      ...event,
      invocationId: "queued",
      subject: { type: "task", taskId: "queued" },
    });
    const activeRow = getOnlyRow(active);
    expect(
      sameHumanTreeRowProps(
        { ...common, row: activeRow, spinnerFrame: 0 },
        { ...common, row: activeRow, spinnerFrame: 1 },
      ),
    ).toBe(false);
  });

  it("updates task completion through React rerender", async () => {
    const initial = reduceRunEvents([
      { type: "run.started", ...event },
      {
        type: "invocation.created",
        ...event,
        invocationId: "task-1",
        planNodeId: "task-1",
        subject: { type: "task", taskId: "build" },
        taskId: "build",
        kind: "task",
        label: "Build",
        siblingOrder: 0,
        dependencyIds: [],
      },
    ]);
    const props = {
      capabilities: { supportsAnsi: false, supportsUnicode: true, width: 80 },
      spinnerFrame: 0,
    };
    const rendered = render(<HumanApp {...props} view={initial} />);
    expect(rendered.lastFrame()).toContain("queued");
    const completed = reduceRunViewModel(initial, {
      type: "invocation.succeeded",
      ...event,
      invocationId: "task-1",
    });
    rendered.rerender(<HumanApp {...props} view={completed} />);
    await vi.waitFor(() => expect(rendered.lastFrame()).toContain("✓ Build"));
    expect(rendered.lastFrame()).toContain("1/1");
    expect(rendered.lastFrame()).not.toContain("queued");
    rendered.unmount();
  });

  it("keeps status and facts in a narrow ASCII terminal", () => {
    const view = reduceRunEvents([
      { type: "run.started", ...event },
      {
        type: "invocation.created",
        ...event,
        invocationId: "task-1",
        planNodeId: "task-1",
        subject: { type: "task", taskId: "task" },
        taskId: "task",
        kind: "task",
        label: "A deliberately long task label for a compact terminal",
        siblingOrder: 0,
        dependencyIds: [],
      },
    ] satisfies SeqlaneExecutionEvent[]);

    const rendered = render(
      <HumanApp
        view={view}
        capabilities={{
          supportsAnsi: false,
          supportsUnicode: false,
          width: 40,
          height: 12,
        }}
        spinnerFrame={0}
      />,
    );

    const output = rendered.lastFrame() ?? "";
    expect(output).toContain(".");
    expect(output).toContain("queued");
    expect(output).not.toContain("help");
    expect(output.split("\n").every((line) => line.length <= 40)).toBe(true);
  });
});
