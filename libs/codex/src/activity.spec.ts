// @test-scope ./activity.ts
import type { AgentActivity } from "@seqlane/agent-adapter";
import { describe, expect, it } from "vitest";
import {
  CodexActivityReducer,
  MAX_TURN_ACTIVITY_EVENTS,
  MAX_TURN_ITEM_BYTES,
  MAX_TURN_ITEMS_BYTES,
} from "./activity.js";

describe("Codex activity reducer", () => {
  it("forwards more than 1,024 small fragments without truncation", () => {
    const activities: AgentActivity[] = [];
    const reducer = new CodexActivityReducer((activity) =>
      activities.push(activity),
    );

    for (let index = 0; index < 2_048; index += 1) {
      reducer.delta("same-message", "a");
    }

    expect(activities).toHaveLength(2_048);
    expect(activities.every(({ message }) => message === "a")).toBe(true);
  });

  it("emits one truncation notice when the event budget is exhausted", () => {
    const activities: AgentActivity[] = [];
    const reducer = new CodexActivityReducer((activity) =>
      activities.push(activity),
    );

    for (let index = 0; index < MAX_TURN_ACTIVITY_EVENTS + 100; index += 1) {
      reducer.delta("same-message", "a");
    }
    reducer.started({ id: "late-tool", type: "commandExecution" });
    reducer.completed({ id: "late-tool", type: "commandExecution" });

    expect(activities).toHaveLength(MAX_TURN_ACTIVITY_EVENTS + 1);
    expect(activities.at(-1)).toMatchObject({
      state: "progress",
      metadata: { truncated: true },
    });
  });

  it("truncates activity when the byte budget is exhausted", () => {
    const activities: AgentActivity[] = [];
    const reducer = new CodexActivityReducer((activity) =>
      activities.push(activity),
    );
    const item = {
      id: "tool-1",
      type: "commandExecution",
      input: "a".repeat(900_000),
    };

    for (let index = 0; index < 12; index += 1) reducer.started(item);
    reducer.completed({ id: item.id, type: item.type });

    expect(activities).toHaveLength(9);
    expect(activities.at(-1)?.metadata).toEqual({ truncated: true });
    expect(
      activities
        .slice(0, -1)
        .reduce(
          (total, activity) =>
            total + Buffer.byteLength(JSON.stringify(activity), "utf8"),
          0,
        ),
    ).toBeLessThan(MAX_TURN_ITEMS_BYTES);
  });

  it("rejects an oversized individual activity", () => {
    const reducer = new CodexActivityReducer(() => undefined);

    expect(() =>
      reducer.delta("message", "a".repeat(MAX_TURN_ITEM_BYTES)),
    ).toThrow(expect.objectContaining({ code: "limit" }));
  });

  it("preserves started metadata when an activity completes", () => {
    const activities: AgentActivity[] = [];
    const reducer = new CodexActivityReducer((activity) =>
      activities.push(activity),
    );

    reducer.started(
      { id: "tool-1", type: "commandExecution", input: { command: "true" } },
      10,
    );
    reducer.completed(
      { id: "tool-1", type: "commandExecution", status: "completed" },
      20,
    );

    expect(activities[1]).toMatchObject({
      activityId: "tool-1",
      name: "commandExecution",
      input: { command: "true" },
      startedAt: 10,
      endedAt: 20,
      state: "succeeded",
    });
  });
});
