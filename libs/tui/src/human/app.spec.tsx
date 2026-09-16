// @test-scope ./app.tsx ./header.tsx ./tree.tsx ./tree-row.tsx ./format.ts ./theme.ts
import { cleanup, render } from "ink-testing-library";
import { stripVTControlCharacters } from "node:util";
import type { SeqlaneExecutionEvent } from "@seqlane/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reduceRunEvents, reduceRunViewModel } from "../run-view-model.js";
import { HumanApp, LiveHumanApp } from "./app.js";

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
        expect(lines[2]).toContain(expected);
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
    expect(rendered.lastFrame()).toContain("0/6");
    expect(rendered.lastFrame()).toContain("omitted nodes=4");
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
