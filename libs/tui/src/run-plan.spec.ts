// @test-scope ./run-view-model.ts ./run-plan.ts ./run-topology.ts
import { expect, it } from "vitest";
import type { SeqlaneExecutionEvent } from "@seqlane/protocol";
import {
  reduceRunEventBatch,
  reduceRunEvents,
  reduceRunViewModel,
} from "./run-view-model.js";

const identity = {
  workId: "work",
  runId: "run",
  metadata: {
    schemaVersion: 1 as const,
    eventId: "event",
    sequence: 1,
    occurredAt: "2026-09-16T00:00:00Z",
  },
};
function plan(
  size: number,
): Extract<SeqlaneExecutionEvent, { type: "run.plan" }> {
  return {
    ...identity,
    type: "run.plan",
    plan: {
      workflow: { id: "large" },
      nodes: Array.from({ length: size }, (_, index) => ({
        planNodeId: String(index),
        type: index === 0 ? "workflow" : "task",
        taskId: String(index),
        label: String(index),
        siblingOrder: index,
        parentPlanNodeId: index === 0 ? undefined : "0",
        dependsOn: index > 1 ? [String(index - 1)] : [],
        session:
          index === 1
            ? {
                type: "isolated",
                model: { model: { provider: "openai", model: "test-model" } },
              }
            : undefined,
      })),
    },
  };
}

it("builds a bounded 10,000-node plan with correct topology and aggregates", () => {
  const started = performance.now();
  const view = reduceRunEvents([plan(10_001)]);
  expect(performance.now() - started).toBeLessThan(3000);
  expect(view.nodes.size).toBe(10000);
  expect(view.omittedNodeCount).toBe(1);
  expect(view.nodes.get("plan:0")?.aggregate.queued).toBe(9999);
  expect(view.childrenByParent.get("plan:0")).toHaveLength(9999);
  expect(view.nodes.get("plan:2")?.dependencyIds).toEqual(["plan:1"]);
});

it("reconciles created invocations without losing plan context or references", () => {
  const initial = reduceRunEvents([plan(3)]);
  const event: SeqlaneExecutionEvent = {
    ...identity,
    type: "invocation.created",
    invocationId: "live",
    planNodeId: "1",
    subject: { type: "task", taskId: "1" },
    taskId: "1",
    kind: "task",
    label: "Live task",
    siblingOrder: 1,
    parentInvocationId: "plan:0",
    dependencyIds: [],
  };
  const view = reduceRunViewModel(initial, event);
  expect(view.nodes.has("plan:1")).toBe(false);
  expect(view.nodes.get("live")?.session).toEqual(
    initial.nodes.get("plan:1")?.session,
  );
  expect(view.nodes.get("live")?.label).toBe("Live task");
  expect(view.nodes.get("plan:2")?.dependencyIds).toEqual(["live"]);
  expect(view.childrenByParent.get("plan:0")).toEqual(["live", "plan:2"]);
  expect(initial.nodes.has("plan:1")).toBe(true);
});

it("reconciles 10,000 planned invocations in one linear batch", () => {
  const created = Array.from(
    { length: 10_000 },
    (_, index): SeqlaneExecutionEvent => ({
      ...identity,
      type: "invocation.created",
      invocationId: `live:${index}`,
      planNodeId: String(index),
      subject: { type: "task", taskId: String(index) },
      taskId: String(index),
      kind: index === 0 ? "workflow" : "task",
      label: `Live ${index}`,
      siblingOrder: index,
      parentInvocationId: index === 0 ? undefined : "live:0",
      dependencyIds: index > 1 ? [`live:${index - 1}`] : [],
    }),
  );
  const started = performance.now();
  const view = reduceRunEvents([plan(10_000), ...created]);
  expect(performance.now() - started).toBeLessThan(3000);
  expect(view.nodes.size).toBe(10_000);
  expect(view.nodes.has("plan:9999")).toBe(false);
  expect(view.nodes.get("live:9999")?.dependencyIds).toEqual(["live:9998"]);
  expect(view.childrenByParent.get("live:0")).toHaveLength(9_999);
});

it("projects many lifecycle events without per-event full-map copies", () => {
  const initial = reduceRunEvents([plan(10_000)]);
  const events = Array.from(
    { length: 10_000 },
    (_, index): SeqlaneExecutionEvent => ({
      ...identity,
      type: "invocation.activity",
      invocationId: `plan:${index}`,
      activityId: `activity:${index}`,
      kind: "tool",
      name: "filesystem.read",
      state: "succeeded",
    }),
  );
  const started = performance.now();
  const view = reduceRunEventBatch(initial, events);
  expect(performance.now() - started).toBeLessThan(3000);
  expect(view.nodes.size).toBe(10_000);
  expect(view.nodes.get("plan:9999")?.activity).toBe(
    "tool filesystem.read succeeded",
  );
  expect(initial.nodes.get("plan:9999")?.activity).toBeUndefined();
});

it("enforces shared run bytes and releases replaced transient bytes", () => {
  let view = reduceRunEvents([plan(3)], {
    limits: { nodeDetailBytes: 8, runDetailBytes: 10 },
  });
  const output = (
    invocationId: string,
    content: string,
  ): SeqlaneExecutionEvent => ({
    ...identity,
    type: "invocation.output",
    invocationId,
    content,
    policy: "transient",
    channel: "task",
  });
  view = reduceRunViewModel(view, output("plan:1", "12345678"));
  view = reduceRunViewModel(view, output("plan:1", "12"));
  expect(view.retainedDetailBytes).toBe(2);
  view = reduceRunViewModel(view, output("plan:2", "abcdefghijk"));
  expect(view.retainedDetailBytes).toBe(10);
  expect(view.nodes.get("plan:2")?.output.truncated).toBe(true);
  for (let index = 0; index < 1000; index += 1)
    view = reduceRunViewModel(view, output("plan:2", "ignored"));
  expect(view.retainedDetailBytes).toBe(10);
  expect(view.detailsTruncated).toBe(true);
});
