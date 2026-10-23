// @test-scope ./run-view-model.ts ./human/format.ts
import { describe, expect, it } from "vitest";
import {
  reduceRunEvents,
  reduceRunViewModel,
  getRunVisibleRows,
} from "./run-view-model.js";
import { nodeFacts } from "./human/format.js";
import type { InteractionRequestedEvent } from "@seqlane/protocol";

const identity = {
  workId: "work",
  runId: "run",
  invocationId: "invocation",
  subject: { type: "task" as const, taskId: "task" },
  metadata: {
    schemaVersion: 1 as const,
    eventId: "event",
    sequence: 1,
    occurredAt: "2026-10-24T00:00:00.000Z",
  },
};
const request: InteractionRequestedEvent = {
  ...identity,
  type: "interaction.requested",
  kind: "user-input",
  requestId: "question",
  expiresAt: "2026-10-24T00:05:00.000Z",
  questions: [{ id: "note", prompt: "Note?", allowFreeText: true }],
};

describe("canonical input wait projection", () => {
  it("stays active, survives activity updates, and clears only the matching request", () => {
    let view = reduceRunEvents([
      {
        ...identity,
        type: "invocation.created",
        planNodeId: "task",
        kind: "task",
        taskId: "task",
        label: "Task",
        siblingOrder: 0,
        dependencyIds: [],
      },
      { ...identity, type: "invocation.started" },
      request,
      {
        ...identity,
        type: "invocation.activity",
        activityId: "tool",
        kind: "tool",
        name: "tool",
        state: "succeeded",
        activityMetadata: { state: "present", value: { truncated: true } },
      },
    ]);
    const row = getRunVisibleRows(view)[0];
    expect(row?.node.state).toBe("active");
    expect(row && nodeFacts(row, new Date())).toBe("waiting for input");
    view = reduceRunViewModel(view, {
      ...request,
      type: "interaction.resolved",
      requestId: "stale",
      status: "expired",
    });
    expect(getRunVisibleRows(view)[0]?.node.pendingInputRequestId).toBe(
      "question",
    );
    view = reduceRunViewModel(view, {
      ...request,
      type: "interaction.resolved",
      status: "answered",
    });
    expect(
      getRunVisibleRows(view)[0]?.node.pendingInputRequestId,
    ).toBeUndefined();
    expect(getRunVisibleRows(view)[0]?.node.state).toBe("active");
  });
});
