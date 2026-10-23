// @test-scope ./contracts.ts
// @test-scope ./errors.ts
// @test-scope ./output.ts
// @test-scope ./stream.ts

import type {
  SessionNotification,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { parseAcpLaunchConfiguration } from "./contracts.js";
import {
  AcpAdapterError,
  AcpLimitError,
  AcpStructuredOutputError,
} from "./errors.js";
import {
  MAX_STRUCTURED_OUTPUT_LENGTH,
  parseStructuredOutput,
} from "./output.js";
import {
  MAX_ACTIVITY_COUNT,
  MAX_ACTIVITY_INPUT_LENGTH,
  MAX_TOOL_RESULT_BYTES,
  MAX_TOOL_RECORD_COUNT,
  AcpToolReducer,
} from "./stream.js";

describe("ACP configuration and native event projection", () => {
  it("keeps an explicitly selected advertised model in validated configuration", () => {
    expect(
      parseAcpLaunchConfiguration({
        id: "agent",
        description: "test",
        command: "agent",
        persistSession: true,
        model: "vendor/model",
      }),
    ).toMatchObject({ persistSession: true, model: "vendor/model" });
  });

  it("preserves native partial tool updates as cumulative snapshots", () => {
    const activities: unknown[] = [];
    const reducer = new AcpToolReducer("invoke", {
      onActivity: (activity) => activities.push(activity),
    });
    const start: SessionNotification = {
      sessionId: "session",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Read file",
        kind: "read",
        status: "in_progress",
        rawInput: { path: "README.md" },
        content: [
          { type: "content", content: { type: "text", text: "partial" } },
        ],
        locations: [{ path: "/workspace/README.md" }],
        _meta: { first: true },
      },
      _meta: { trace: "one" },
    };
    Object.assign(start.update, { futureExtension: { retained: true } });
    const finishUpdate = {
      sessionUpdate: "tool_call_update" as const,
      toolCallId: "tool-1",
      status: "completed" as const,
      name: null,
      title: null,
      kind: null,
      rawOutput: { read: true },
      futureUpdate: [false, 0, ""],
      _meta: null,
    };
    const finish: SessionNotification = {
      sessionId: "session",
      update: finishUpdate,
      _meta: { trace: "two" },
    };
    reducer.consume(start.update, start);
    reducer.consume(finish.update, finish);

    expect(activities[0]).toMatchObject({
      state: "started",
      input: { path: "README.md" },
    });
    expect(activities[1]).toMatchObject({
      state: "succeeded",
      name: "Read file",
      input: { path: "README.md" },
      output: { read: true },
      metadata: {
        protocol: "acp-v1",
        snapshot: {
          toolCallId: "tool-1",
          kind: "read",
          title: "Read file",
          status: "completed",
          rawInput: { path: "README.md" },
          rawOutput: { read: true },
          content: [
            { type: "content", content: { type: "text", text: "partial" } },
          ],
          locations: [{ path: "/workspace/README.md" }],
          _meta: null,
          futureExtension: { retained: true },
          futureUpdate: [false, 0, ""],
        },
        notification: finish,
        update: expect.objectContaining({
          name: null,
          title: null,
          kind: null,
        }),
      },
    });
  });

  it("retains full session usage notifications without inventing per-call tokens", () => {
    const observations: unknown[] = [];
    const reducer = new AcpToolReducer("invoke", {
      onObservation: (observation) => observations.push(observation),
    });
    const notification: SessionNotification = {
      sessionId: "session-2",
      update: {
        sessionUpdate: "usage_update",
        used: 42,
        size: 4096,
        cost: {
          amount: 0,
          currency: "USD",
          _meta: { source: false, count: 0, note: "" },
        },
        _meta: { enabled: false, count: 0, note: "" },
      },
      _meta: { correlation: "usage-1", enabled: false, count: 0, note: "" },
    };
    reducer.consume(notification.update, notification);
    expect(observations[0]).toMatchObject({
      kind: "model",
      model: { operation: "acp.session.usage", usage: notification },
      availability: [
        { path: "model.model", reason: "source-unavailable" },
        { path: "model.provider", reason: "source-unavailable" },
        { path: "model.cost", reason: "source-unavailable" },
      ],
    });
    expect(JSON.stringify(observations[0])).not.toContain("inputTokens");
    expect(JSON.stringify(observations[0])).toContain('"amount":0');
    expect(JSON.stringify(observations[0])).toContain('"enabled":false');
  });

  it("retains full usage metadata above the tool-result source bound", () => {
    const observations: unknown[] = [];
    const reducer = new AcpToolReducer("large-usage", {
      onObservation: (observation) => observations.push(observation),
    });
    const notification: SessionNotification = {
      sessionId: "large-usage",
      update: {
        sessionUpdate: "usage_update",
        used: 42,
        size: 4096,
        _meta: { providerExtension: "x".repeat(MAX_TOOL_RESULT_BYTES + 1) },
      },
    };

    reducer.consume(notification.update, notification);

    expect(observations[0]).toMatchObject({
      model: { usage: notification },
    });
  });

  it("rejects non-JSON tool payloads instead of dropping invalid fields", () => {
    const reducer = new AcpToolReducer("invoke", {});
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "bad metadata",
      kind: "other",
      rawInput: { impossible: Number.POSITIVE_INFINITY },
      status: "in_progress",
    };
    expect(() => reducer.consume(update)).toThrow(AcpAdapterError);
  });

  it("keeps structured-output parsing bounds and schema failures explicit", () => {
    expect(parseStructuredOutput('{"value":"ok"}')).toEqual({ value: "ok" });
    expect(() => parseStructuredOutput("not json")).toThrow(
      AcpStructuredOutputError,
    );
    const validAtLimit =
      '{"value":1}' +
      " ".repeat(MAX_STRUCTURED_OUTPUT_LENGTH - '{"value":1}'.length);
    expect(validAtLimit.length).toBe(MAX_STRUCTURED_OUTPUT_LENGTH);
    expect(parseStructuredOutput(validAtLimit)).toEqual({ value: 1 });
    expect(() =>
      parseStructuredOutput(" ".repeat(MAX_STRUCTURED_OUTPUT_LENGTH + 1)),
    ).toThrow(AcpLimitError);
  });

  it("rejects tool inputs and outputs above their source byte limits", () => {
    const inputReducer = new AcpToolReducer("input-limit", {});
    expect(() =>
      inputReducer.consume({
        sessionUpdate: "tool_call",
        toolCallId: "input-limit",
        title: "Large input",
        kind: "other",
        status: "in_progress",
        rawInput: "x".repeat(MAX_ACTIVITY_INPUT_LENGTH + 1),
      }),
    ).toThrow(AcpLimitError);

    const outputReducer = new AcpToolReducer("output-limit", {});
    expect(() =>
      outputReducer.consume({
        sessionUpdate: "tool_call",
        toolCallId: "output-limit",
        title: "Large output",
        kind: "other",
        status: "completed",
        rawOutput: "x".repeat(MAX_TOOL_RESULT_BYTES + 1),
      }),
    ).toThrow(AcpLimitError);
  });

  it("keeps the aggregate native tool-input budget across records", () => {
    const reducer = new AcpToolReducer("aggregate-input", {});
    reducer.consume({
      sessionUpdate: "tool_call",
      toolCallId: "first-input",
      title: "First input",
      kind: "other",
      status: "in_progress",
      rawInput: "x".repeat(600_000),
    });

    expect(() =>
      reducer.consume({
        sessionUpdate: "tool_call",
        toolCallId: "second-input",
        title: "Second input",
        kind: "other",
        status: "in_progress",
        rawInput: "x".repeat(400_001),
      }),
    ).toThrow(AcpLimitError);
  });

  it("keeps a 500 KB output inside a full native notification projection", () => {
    const activities: unknown[] = [];
    const reducer = new AcpToolReducer("projected-output", {
      onActivity: (activity) => activities.push(activity),
    });
    const rawOutput = "x".repeat(500_000);
    const notification: SessionNotification = {
      sessionId: "projected-output",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "large-tool",
        title: "Large result",
        kind: "other",
        status: "completed",
        rawOutput,
      },
      _meta: { trace: "full-notification" },
    };

    reducer.consume(notification.update, notification);

    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      output: rawOutput,
      metadata: {
        snapshot: { rawOutput },
        update: { rawOutput },
        notification,
      },
    });
  });

  it("accepts the exact serialized tool-output byte limit and rejects one multibyte character over", () => {
    const outputAtLimit = "é".repeat((MAX_TOOL_RESULT_BYTES - 2) / 2);
    expect(
      new TextEncoder().encode(JSON.stringify(outputAtLimit)).byteLength,
    ).toBe(MAX_TOOL_RESULT_BYTES);

    const activities: unknown[] = [];
    const reducer = new AcpToolReducer("serialized-boundary", {
      onActivity: (activity) => activities.push(activity),
    });
    reducer.consume({
      sessionUpdate: "tool_call",
      toolCallId: "exact-output",
      title: "Exact serialized output",
      kind: "other",
      status: "completed",
      rawOutput: outputAtLimit,
    });
    expect(activities[0]).toMatchObject({ output: outputAtLimit });

    const oversizedReducer = new AcpToolReducer("serialized-overflow", {});
    expect(() =>
      oversizedReducer.consume({
        sessionUpdate: "tool_call",
        toolCallId: "over-output",
        title: "Oversized serialized output",
        kind: "other",
        status: "completed",
        rawOutput: `${outputAtLimit}é`,
      }),
    ).toThrow(AcpLimitError);
  });

  it("enforces tool-record and activity-count limits through emitted activities", () => {
    const recordsReducer = new AcpToolReducer("records", {});
    for (let index = 0; index < MAX_TOOL_RECORD_COUNT; index += 1) {
      recordsReducer.consume({
        sessionUpdate: "tool_call_update",
        toolCallId: `record-${index}`,
      });
    }
    expect(() =>
      recordsReducer.consume({
        sessionUpdate: "tool_call_update",
        toolCallId: "record-overflow",
      }),
    ).toThrow(AcpLimitError);

    let emitted = 0;
    const activitiesReducer = new AcpToolReducer("activities", {
      onActivity: () => {
        emitted += 1;
      },
    });
    activitiesReducer.consume({
      sessionUpdate: "tool_call",
      toolCallId: "activity-limit",
      title: "Repeated progress",
      kind: "other",
      status: "in_progress",
    });
    for (let index = 1; index < MAX_ACTIVITY_COUNT; index += 1) {
      activitiesReducer.consume({
        sessionUpdate: "tool_call_update",
        toolCallId: "activity-limit",
        status: "in_progress",
      });
    }
    expect(emitted).toBe(MAX_ACTIVITY_COUNT);
    expect(() =>
      activitiesReducer.consume({
        sessionUpdate: "tool_call_update",
        toolCallId: "activity-limit",
        status: "in_progress",
      }),
    ).toThrow(AcpLimitError);
  });

  it("rejects malformed JSON payloads without invoking getters or salvaging fields", () => {
    const withGetter: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "getter",
      title: "Getter",
      kind: "other",
      status: "in_progress",
    };
    let getterCalls = 0;
    Object.defineProperty(withGetter, "rawInput", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return { ignored: true };
      },
    });
    expect(() => new AcpToolReducer("getter", {}).consume(withGetter)).toThrow(
      AcpAdapterError,
    );
    expect(getterCalls).toBe(0);

    const circular: { next?: unknown } = {};
    circular.next = circular;
    const invalidUpdates: SessionUpdate[] = [
      {
        sessionUpdate: "tool_call",
        toolCallId: "function",
        title: "fn",
        kind: "other",
        status: "in_progress",
        rawInput: () => undefined,
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "undefined",
        title: "undefined",
        kind: "other",
        status: "in_progress",
        rawInput: { nested: undefined },
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "array-hole",
        title: "hole",
        kind: "other",
        status: "in_progress",
        rawInput: [undefined],
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "cycle",
        title: "cycle",
        kind: "other",
        status: "in_progress",
        rawInput: circular,
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "non-finite",
        title: "non-finite",
        kind: "other",
        status: "in_progress",
        rawInput: Number.NaN,
      },
    ];
    for (const update of invalidUpdates) {
      expect(() => new AcpToolReducer("invalid", {}).consume(update)).toThrow(
        AcpAdapterError,
      );
    }
  });

  it("keeps terminal tool activity single-shot and does not mutate it for late updates", () => {
    const activities: unknown[] = [];
    const diagnostics: unknown[] = [];
    const reducer = new AcpToolReducer("terminal", {
      onActivity: (activity) => activities.push(activity),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    reducer.consume({
      sessionUpdate: "tool_call",
      toolCallId: "terminal-tool",
      title: "Terminal",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "before" },
    });
    reducer.consume({
      sessionUpdate: "tool_call_update",
      toolCallId: "terminal-tool",
      status: "completed",
      rawOutput: null,
    });
    reducer.consume({
      sessionUpdate: "tool_call_update",
      toolCallId: "terminal-tool",
      status: "failed",
      rawInput: { command: "late" },
    });
    reducer.consume({
      sessionUpdate: "tool_call",
      toolCallId: "terminal-tool",
      title: "Duplicate terminal",
      kind: "execute",
      status: "completed",
      rawOutput: { late: true },
    });
    reducer.finishAttempt("failed");
    expect(activities).toHaveLength(2);
    expect(activities[1]).toMatchObject({
      state: "succeeded",
      input: { command: "before" },
      output: null,
    });
    expect(diagnostics).toHaveLength(2);
  });

  it("retains prior native fields on the synthetic failed terminal activity", () => {
    const activities: unknown[] = [];
    const reducer = new AcpToolReducer("synthetic-terminal", {
      onActivity: (activity) => activities.push(activity),
    });
    const start: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "open-tool",
      title: "Open tool",
      kind: "read",
      status: "in_progress",
      rawInput: { path: "input.txt" },
      rawOutput: null,
    };
    Object.assign(start, { extensionField: { preserved: true } });
    reducer.consume(start);
    reducer.finishAttempt("cancelled");
    expect(activities[1]).toMatchObject({
      state: "failed",
      input: { path: "input.txt" },
      output: null,
      metadata: {
        snapshot: { kind: "read", extensionField: { preserved: true } },
        update: { extensionField: { preserved: true } },
        terminalReason: "cancelled",
      },
    });
  });

  it("finishes every open activity when a terminal activity callback throws", () => {
    const terminalIds: string[] = [];
    let shouldThrow = true;
    const reducer = new AcpToolReducer("callback-failure", {
      onActivity: (activity) => {
        if (activity.state !== "failed") return;
        terminalIds.push(activity.activityId);
        if (shouldThrow) {
          shouldThrow = false;
          throw new Error("activity sink failed");
        }
      },
    });
    for (const id of ["first-open", "second-open"]) {
      reducer.consume({
        sessionUpdate: "tool_call",
        toolCallId: id,
        title: id,
        kind: "other",
        status: "in_progress",
      });
    }
    expect(() => reducer.finishAttempt("failed")).toThrow(
      "activity sink failed",
    );
    expect(terminalIds).toEqual(["first-open", "second-open"]);
  });
});
