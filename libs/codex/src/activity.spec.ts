// @test-scope ./activity.ts
import type { AgentActivity } from "@seqlane/agent-adapter";
import { describe, expect, it } from "vitest";
import { CodexActivityReducer } from "./activity.js";

describe("Codex activity reducer", () => {
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
