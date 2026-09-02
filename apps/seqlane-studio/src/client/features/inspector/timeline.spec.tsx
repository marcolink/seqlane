import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { StudioStreamEvent } from "@seqlane/studio/protocol";
import { Timeline, updateExpandedTimelineCursor } from "./timeline.js";

describe("Timeline", () => {
  it("keeps the newest expanded event open when another event closes", () => {
    expect(updateExpandedTimelineCursor(8, 9, true)).toBe(9);
    expect(updateExpandedTimelineCursor(9, 8, false)).toBe(9);
    expect(updateExpandedTimelineCursor(9, 9, false)).toBeUndefined();
  });

  it("renders collapsed, typed event rows with their full payload available", () => {
    const item = {
      cursor: 12,
      workflowId: "workflow-1",
      event: {
        type: "invocation.failed",
        workId: "work-1",
        runId: "run-1",
        invocationId: "invocation-1",
        disposition: "retry_scheduled",
        error: {
          category: "ExecutorError",
          message: "The executor did not respond.",
        },
        metadata: {
          schemaVersion: 1,
          eventId: "event-12",
          sequence: 12,
          occurredAt: "2026-08-29T22:00:12.000Z",
        },
      },
    } satisfies StudioStreamEvent;

    const markup = renderToStaticMarkup(
      <Timeline
        items={[item]}
        snapshot={{
          summary: {
            workId: "work-1",
            runId: "run-1",
            workflowId: "workflow-1",
            state: "failed",
            isIncomplete: false,
            activeInvocationCount: 0,
            lastEventSequence: 12,
          },
          cursor: 12,
          invocations: [
            {
              invocationId: "invocation-1",
              planNodeId: "node-1",
              taskId: "task-1",
              kind: "task",
              label: "Prepare release",
              siblingOrder: 0,
              dependencyIds: [],
              state: "failed",
              output: { persistent: [] },
            },
          ],
        }}
      />,
    );

    expect(markup).toContain('class="studio-disclosure timeline-event"');
    expect(markup).not.toContain(" open");
    expect(markup).toContain("Invocation failed");
    expect(markup).toContain("Prepare release");
    expect(markup).toContain("The executor did not respond.");
    expect(markup).toContain("timeline-event__icon--failure");
    expect(markup).toContain(
      "&quot;disposition&quot;: &quot;retry_scheduled&quot;",
    );
  });
});
