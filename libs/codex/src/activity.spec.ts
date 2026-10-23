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
    reducer.terminateOpenActivities(20, "interrupted");

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
    reducer.terminateOpenActivities(20, "interrupted");

    expect(activities).toHaveLength(9);
    expect(activities.at(-1)?.metadata).toEqual({ truncated: true });
    expect(
      activities
        .slice(0, -1)
        .reduce(
          (total, activity) =>
            total +
            Buffer.byteLength(JSON.stringify(activity.metadata), "utf8"),
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

  it("rejects oversized activity after truncation", () => {
    const reducer = new CodexActivityReducer(() => undefined);
    for (let index = 0; index <= MAX_TURN_ACTIVITY_EVENTS; index += 1) {
      reducer.delta("message", "a");
    }

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

  it("projects native command execution fields and retains the full item", () => {
    const activities: AgentActivity[] = [];
    const reducer = new CodexActivityReducer((activity) =>
      activities.push(activity),
    );
    const started = {
      id: "command-1",
      type: "commandExecution",
      command: "printf hello",
      cwd: "/workspace",
      commandActions: [],
      status: "inProgress",
    };
    const completed = {
      ...started,
      status: "completed",
      aggregatedOutput: "hello",
      durationMs: 0,
      exitCode: 0,
    };

    reducer.started(started, 10);
    reducer.completed(completed, 20);

    expect(activities[0]).toMatchObject({
      input: {
        command: "printf hello",
        cwd: "/workspace",
        commandActions: started.commandActions,
      },
      metadata: started,
    });
    expect(activities[1]).toMatchObject({
      input: {
        command: "printf hello",
        cwd: "/workspace",
        commandActions: started.commandActions,
      },
      output: "hello",
      metadata: completed,
      endedAt: 20,
    });
  });

  it("projects native MCP arguments and result without losing false-like values", () => {
    const activities: AgentActivity[] = [];
    const reducer = new CodexActivityReducer((activity) =>
      activities.push(activity),
    );
    const argumentsValue = {
      enabled: false,
      count: 0,
      text: "",
      nested: { items: [""] },
    };
    const result = {
      enabled: false,
      count: 0,
      text: "",
      nested: { items: [""] },
    };
    const started = {
      id: "mcp-1",
      type: "mcpToolCall",
      server: "fixture",
      tool: "fixture.read",
      status: "inProgress",
      arguments: argumentsValue,
      readOnlyHint: false,
      pluginId: "",
    };
    const completed = {
      ...started,
      status: "completed",
      result: {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
        _meta: argumentsValue,
      },
      error: null,
      durationMs: 0,
    };

    reducer.started(started, 10);
    reducer.completed(completed, 20);

    expect(activities[0]).toMatchObject({
      input: argumentsValue,
      metadata: started,
    });
    expect(activities[1]).toMatchObject({
      input: argumentsValue,
      output: completed.result,
      metadata: completed,
      endedAt: 20,
      state: "succeeded",
    });
  });
});
