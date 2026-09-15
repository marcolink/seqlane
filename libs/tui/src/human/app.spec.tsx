// @test-scope ./app.tsx ./header.tsx ./tree.tsx ./tree-row.tsx ./details.tsx ./format.ts
import { renderToString } from "ink";
import type { SeqlaneExecutionEvent } from "@seqlane/protocol";
import { describe, expect, it } from "vitest";
import { reduceRunEvents } from "../run-view-model.js";
import { HumanApp } from "./app.js";

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
  it("composes the header, tree, details, and active controls", () => {
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

    const output = renderToString(
      <HumanApp
        view={view}
        capabilities={{ supportsAnsi: false, supportsUnicode: false }}
        spinnerFrame={0}
        detailsVisible
        helpVisible
        onInput={() => undefined}
      />,
      { columns: 100 },
    );

    expect(output).toContain("Build release active");
    expect(output).toContain("Build release");
    expect(output).toContain("help");
  });

  it("keeps status and cancellation controls in a narrow ASCII terminal", () => {
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

    const output = renderToString(
      <HumanApp
        view={view}
        capabilities={{
          supportsAnsi: false,
          supportsUnicode: false,
          width: 40,
          height: 12,
        }}
        spinnerFrame={0}
        detailsVisible
        helpVisible={false}
        onInput={() => undefined}
      />,
      { columns: 40, rows: 12 },
    );

    expect(output).toContain(".");
    expect(output).toContain("? help · ^C cancel");
  });
});
