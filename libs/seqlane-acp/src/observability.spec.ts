// @test-scope ./observability.ts
// @test-scope ./stream.ts

import { SpanType } from "@mastra/core/observability";
import { describe, expect, it } from "vitest";
import {
  AcpToolReducer,
  MAX_ACTIVITY_COUNT,
  MAX_ACTIVITY_INPUT_LENGTH,
  MAX_TOOL_RECORD_COUNT,
  MAX_TOOL_RESULT_BYTES,
  reportAcpStreamChunk,
} from "./stream.js";
import { createAcpObservability } from "./observability.js";

type SpanOperation = "create" | "end" | "error";

interface SpanRecord {
  readonly id: string;
  readonly type: SpanType;
  readonly parent?: SpanRecord;
  readonly createOptions?: Record<string, unknown>;
  readonly startTime: Date;
  readonly endCalls: unknown[];
  readonly errorCalls: unknown[];
}

function spanSink(
  shouldFail: (operation: SpanOperation, type: SpanType) => boolean = () =>
    false,
) {
  const spans: SpanRecord[] = [];
  const closeOrder: string[] = [];

  const attach = (record: SpanRecord): object => ({
    id: record.id,
    type: record.type,
    name: String(record.createOptions?.name ?? "workflow step"),
    traceId: "trace",
    startTime: record.startTime,
    isValid: true,
    createChildSpan: (options: Record<string, unknown>) => {
      const type = options.type as SpanType;
      if (shouldFail("create", type)) throw new Error("span create failed");
      const child: SpanRecord = {
        id: `${type}-${spans.length}`,
        type,
        parent: record,
        createOptions: options,
        startTime: new Date(),
        endCalls: [],
        errorCalls: [],
      };
      spans.push(child);
      return attach(child);
    },
    end: (options?: unknown) => {
      record.endCalls.push(options);
      if (shouldFail("end", record.type)) throw new Error("span end failed");
      closeOrder.push(record.id);
    },
    error: (options: unknown) => {
      record.errorCalls.push(options);
      if (shouldFail("error", record.type))
        throw new Error("span error failed");
      closeOrder.push(record.id);
    },
    update: () => undefined,
  });

  const root: SpanRecord = {
    id: "workflow-step",
    type: SpanType.WORKFLOW_STEP,
    startTime: new Date(),
    endCalls: [],
    errorCalls: [],
  };
  spans.push(root);

  return { root: attach(root) as never, spans, closeOrder };
}

function openTool(
  reducer: AcpToolReducer,
  attemptIndex: number,
  toolCallId: string,
  toolName: string,
  argsTextDelta?: string,
): void {
  reducer.consume(
    {
      type: "tool-call-delta",
      payload: {
        toolCallId,
        toolName,
        ...(argsTextDelta === undefined ? {} : { argsTextDelta }),
      },
    },
    attemptIndex,
  );
}

function closeTool(
  reducer: AcpToolReducer,
  attemptIndex: number,
  toolCallId: string,
  toolName: string,
  isError?: boolean,
): void {
  reducer.consume(
    {
      type: "tool-result",
      payload: {
        toolCallId,
        toolName,
        ...(isError === undefined ? {} : { isError }),
      },
    },
    attemptIndex,
  );
}

function projectedReducer(
  sink: ReturnType<typeof spanSink>,
  diagnostics: string[] = [],
) {
  const projection = createAcpObservability(
    { tracingContext: { currentSpan: sink.root } },
    "invocation-1",
    (message) => diagnostics.push(message),
  );
  const reducer = new AcpToolReducer("invocation-1", {
    onToolOpened: projection.onToolOpened,
    onToolClosed: projection.onToolClosed,
    onDiagnostic: ({ code }) => diagnostics.push(code),
  });
  return { projection, reducer };
}

describe("ACP v1 Mastra observability", () => {
  it("uses the typed allowlist, normalized span name, local time, and no model telemetry", () => {
    const sink = spanSink();
    const diagnostics: string[] = [];
    const projection = createAcpObservability(
      { tracingContext: { currentSpan: sink.root } },
      "invocation-1",
      (message) => diagnostics.push(message),
    );
    const reducer = new AcpToolReducer("invocation-1", {
      onToolOpened: projection.onToolOpened,
      onToolClosed: projection.onToolClosed,
      onDiagnostic: ({ message }) => diagnostics.push(message),
    });

    reducer.consume(
      {
        type: "tool-call",
        payload: {
          toolCallId: "external:call",
          toolName: "ｅｃｈｏ",
          args: { secret: "do not export" },
        },
      },
      0,
    );
    reducer.consume(
      {
        type: "tool-result",
        payload: {
          toolCallId: "external:call",
          toolName: "ｅｃｈｏ",
          result: "do not export",
        },
      },
      0,
    );
    projection.finish();

    const agent = sink.spans.find((span) => span.type === SpanType.AGENT_RUN);
    const tool = sink.spans.find((span) => span.type === SpanType.TOOL_CALL);
    expect(agent?.parent?.type).toBe(SpanType.WORKFLOW_STEP);
    expect(agent?.createOptions).toEqual({
      type: SpanType.AGENT_RUN,
      name: "ACP v1 agent run",
      metadata: {
        "seqlane.invocationId": "invocation-1",
        "seqlane.adapter": "acp-v1",
      },
    });
    expect(tool?.parent).toBe(agent);
    expect(tool?.startTime).toBeInstanceOf(Date);
    expect(tool?.createOptions).toEqual({
      type: SpanType.TOOL_CALL,
      name: "echo",
      attributes: {
        toolType: "tool",
        toolCallId: "external:call",
      },
      metadata: { "seqlane.attemptIndex": 0 },
    });
    expect(JSON.stringify(tool?.createOptions)).not.toContain("do not export");
    expect(tool?.createOptions).not.toHaveProperty("entityName");
    expect(tool?.createOptions).not.toHaveProperty("tags");
    expect(
      sink.spans.some((span) => span.type === SpanType.MODEL_GENERATION),
    ).toBe(false);
    expect(sink.closeOrder).toEqual([tool?.id, agent?.id]);
    expect(diagnostics).toEqual([]);
  });

  it("keeps tuple identity and diagnoses every conflicting name without mutation", () => {
    const opened: string[] = [];
    const closed: string[] = [];
    const activities: unknown[] = [];
    const diagnostics: string[] = [];
    const reducer = new AcpToolReducer("invocation", {
      onToolOpened: (record) => opened.push(`${record.key}:${record.toolName}`),
      onToolClosed: (record, outcome) =>
        closed.push(`${record.key}:${record.toolName}:${outcome}`),
      onActivity: (activity) => activities.push(activity),
      onDiagnostic: ({ code }) => diagnostics.push(code),
    });

    openTool(reducer, 0, "same", "tool");
    openTool(reducer, 0, "same", "other");
    openTool(reducer, 0, "same", "tool");
    openTool(reducer, 1, "same", "tool");
    closeTool(reducer, 0, "same", "tool");
    closeTool(reducer, 0, "same", "tool");
    closeTool(reducer, 0, "same", "other");
    openTool(reducer, 0, "same", "other");
    openTool(reducer, 0, "same", "tool");

    expect(opened).toHaveLength(2);
    expect(opened.every((entry) => entry.endsWith(":tool"))).toBe(true);
    expect(closed).toHaveLength(1);
    expect(closed[0]).toContain(":tool:success");
    expect(activities).toEqual([
      expect.objectContaining({ name: "tool", state: "started" }),
      expect.objectContaining({ name: "tool", state: "progress" }),
      expect.objectContaining({ name: "tool", state: "started" }),
      expect.objectContaining({ name: "tool", state: "succeeded" }),
    ]);
    expect(diagnostics).toEqual([
      "acp-tool-conflicting-name",
      "acp-tool-conflicting-terminal",
      "acp-tool-late-observation",
      "acp-tool-late-observation",
    ]);
  });

  it("bounds repeated late and conflicting diagnostics per invocation", () => {
    const opened: string[] = [];
    const closed: string[] = [];
    const activities: unknown[] = [];
    const diagnostics: Array<{ code: string; message: string }> = [];
    const reducer = new AcpToolReducer("invocation", {
      onToolOpened: (record) => opened.push(record.toolCallId),
      onToolClosed: (record, outcome) =>
        closed.push(`${record.toolCallId}:${outcome}`),
      onActivity: (activity) => activities.push(activity),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    openTool(reducer, 0, "same", "tool");
    for (let index = 0; index < 5; index += 1) {
      openTool(reducer, 0, "same", "other");
    }
    closeTool(reducer, 0, "same", "tool");
    for (let index = 0; index < 5; index += 1) {
      closeTool(reducer, 0, "same", "other");
    }
    for (let index = 0; index < 5; index += 1) {
      openTool(reducer, 0, "same", "tool");
    }

    expect(opened).toEqual(["same"]);
    expect(closed).toEqual(["same:success"]);
    expect(activities).toHaveLength(2);
    expect(diagnostics).toHaveLength(9);
    expect(diagnostics.slice(0, 8).map(({ code }) => code)).toEqual([
      ...Array.from({ length: 5 }, () => "acp-tool-conflicting-name"),
      ...Array.from({ length: 3 }, () => "acp-tool-conflicting-terminal"),
    ]);
    expect(diagnostics[8]).toEqual({
      code: "acp-diagnostics-suppressed",
      message:
        "ACP v1 suppressed additional tool diagnostics after diagnostic budget exhaustion",
    });
  });

  it("rejects an unseen tool result before inspecting its raw result", () => {
    let serializationCount = 0;
    const reducer = new AcpToolReducer("invocation", {});

    expect(() =>
      reducer.consume(
        {
          type: "tool-result",
          payload: {
            toolCallId: "unseen",
            toolName: "tool",
            result: {
              toJSON: () => {
                serializationCount += 1;
                throw new Error("raw result must not be inspected");
              },
            },
          },
        },
        0,
      ),
    ).toThrowError(
      expect.objectContaining({
        name: "AcpMalformedStreamError",
        chunkType: "tool-result",
        cause: undefined,
      }),
    );
    expect(serializationCount).toBe(0);
  });

  it("ignores a matching duplicate terminal without inspecting its raw result", () => {
    let serializationCount = 0;
    const reducer = new AcpToolReducer("invocation", {});
    openTool(reducer, 0, "id", "tool");
    closeTool(reducer, 0, "id", "tool");

    expect(() =>
      reducer.consume(
        {
          type: "tool-result",
          payload: {
            toolCallId: "id",
            toolName: "tool",
            result: {
              toJSON: () => {
                serializationCount += 1;
                throw new Error("duplicate result must not be inspected");
              },
            },
          },
        },
        0,
      ),
    ).not.toThrow();
    expect(serializationCount).toBe(0);
  });

  it("enforces result bounds for the authoritative open-tool terminal", () => {
    const reducer = new AcpToolReducer("invocation", {});
    openTool(reducer, 0, "id", "tool");

    expect(() =>
      reducer.consume(
        {
          type: "tool-result",
          payload: {
            toolCallId: "id",
            toolName: "tool",
            result: "x".repeat(MAX_TOOL_RESULT_BYTES),
          },
        },
        0,
      ),
    ).toThrowError(
      expect.objectContaining({
        name: "AcpLimitError",
        resource: "tool result",
        maximum: MAX_TOOL_RESULT_BYTES,
      }),
    );
  });

  it.each([
    {
      outcome: "success" as const,
      agentOutcome: undefined,
      toolError: undefined,
      toolEnd: { attributes: { success: true } },
      agentError: undefined,
    },
    {
      outcome: "failure" as const,
      agentOutcome: "failed" as const,
      toolError: {
        message: "ACP v1 tool call failed",
        attributes: { success: false },
        metadata: { "seqlane.acp.outcome": "failed" },
      },
      toolEnd: undefined,
      agentError: {
        message: "ACP v1 agent run failed",
        metadata: { "seqlane.acp.outcome": "failed" },
      },
    },
    {
      outcome: "incomplete" as const,
      agentOutcome: undefined,
      toolError: {
        message: "ACP v1 tool call incomplete",
        attributes: undefined,
        metadata: { "seqlane.acp.outcome": "incomplete" },
      },
      toolEnd: undefined,
      agentError: undefined,
    },
    {
      outcome: "cancelled" as const,
      agentOutcome: "cancelled" as const,
      toolError: {
        message: "ACP v1 tool call cancelled",
        attributes: { success: false },
        metadata: { "seqlane.acp.outcome": "cancelled" },
      },
      toolEnd: undefined,
      agentError: {
        message: "ACP v1 agent run cancelled",
        metadata: { "seqlane.acp.outcome": "cancelled" },
      },
    },
  ])(
    "closes $outcome tools exactly before their agent run",
    ({ outcome, agentOutcome, toolError, toolEnd, agentError }) => {
      const sink = spanSink();
      const { projection, reducer } = projectedReducer(sink);
      openTool(reducer, 0, "tool-id", "tool");
      if (outcome === "success" || outcome === "failure") {
        closeTool(reducer, 0, "tool-id", "tool", outcome === "failure");
      } else {
        reducer.finishAttempt(0, outcome);
      }
      projection.finish(agentOutcome);

      const agent = sink.spans.find((span) => span.type === SpanType.AGENT_RUN);
      const tool = sink.spans.find((span) => span.type === SpanType.TOOL_CALL);
      expect(sink.closeOrder).toEqual([tool?.id, agent?.id]);
      if (toolEnd === undefined) expect(tool?.endCalls).toEqual([]);
      else expect(tool?.endCalls).toEqual([toolEnd]);
      if (toolError === undefined) expect(tool?.errorCalls).toEqual([]);
      else {
        expect(tool?.errorCalls).toHaveLength(1);
        const call = tool?.errorCalls[0] as Record<string, unknown>;
        expect(call).toMatchObject({
          endSpan: true,
          metadata: toolError.metadata,
        });
        expect((call.error as Error).message).toBe(toolError.message);
        if (toolError.attributes === undefined)
          expect(call).not.toHaveProperty("attributes");
        else expect(call.attributes).toEqual(toolError.attributes);
      }
      if (agentError === undefined) {
        expect(agent?.endCalls).toEqual([undefined]);
        expect(agent?.errorCalls).toEqual([]);
      } else {
        expect(agent?.endCalls).toEqual([]);
        expect(agent?.errorCalls).toHaveLength(1);
        const call = agent?.errorCalls[0] as Record<string, unknown>;
        expect(call).toMatchObject({
          endSpan: true,
          metadata: agentError.metadata,
        });
        expect((call.error as Error).message).toBe(agentError.message);
      }
    },
  );

  it("keeps completed child success when the enclosing run later fails", () => {
    const sink = spanSink();
    const { projection, reducer } = projectedReducer(sink);
    openTool(reducer, 0, "tool-id", "tool");
    closeTool(reducer, 0, "tool-id", "tool");
    projection.finish("failed");

    const agent = sink.spans.find((span) => span.type === SpanType.AGENT_RUN);
    const tool = sink.spans.find((span) => span.type === SpanType.TOOL_CALL);
    expect(tool?.endCalls).toEqual([{ attributes: { success: true } }]);
    expect(tool?.errorCalls).toEqual([]);
    expect(agent?.errorCalls).toHaveLength(1);
  });

  it("uses fallback names within one invocation-wide cardinality budget", () => {
    const sink = spanSink();
    const diagnostics: string[] = [];
    const { projection, reducer } = projectedReducer(sink, diagnostics);

    for (let index = 0; index < 128; index += 1) {
      openTool(reducer, index % 2, `id-${index}`, `tool-${index}`);
      closeTool(reducer, index % 2, `id-${index}`, `tool-${index}`);
    }
    openTool(reducer, 0, "invalid-id", "invalid name");
    closeTool(reducer, 0, "invalid-id", "invalid name");
    openTool(reducer, 1, "overflow-id", "tool-overflow");
    closeTool(reducer, 1, "overflow-id", "tool-overflow");
    projection.finish();

    const tools = sink.spans.filter((span) => span.type === SpanType.TOOL_CALL);
    expect(tools.at(-2)?.createOptions?.name).toBe("ACP v1 tool call");
    expect(tools.at(-1)?.createOptions).toEqual({
      type: SpanType.TOOL_CALL,
      name: "ACP v1 tool call",
      attributes: { toolType: "tool", toolCallId: "overflow-id" },
      metadata: { "seqlane.attemptIndex": 1 },
    });
    expect(tools.at(-1)?.createOptions).not.toHaveProperty("entityName");
    expect(diagnostics).toEqual([
      "ACP v1 tool name cardinality limit reached; using fallback name",
    ]);
  });

  it("keeps bounded raw ids only in typed attributes and omits oversized invocation ids", () => {
    const sink = spanSink();
    const projection = createAcpObservability(
      { tracingContext: { currentSpan: sink.root } },
      "i".repeat(129),
    );
    const reducer = new AcpToolReducer("i".repeat(129), {
      onToolOpened: projection.onToolOpened,
      onToolClosed: projection.onToolClosed,
    });
    openTool(reducer, 0, "raw-external-id", "raw invalid name");
    closeTool(reducer, 0, "raw-external-id", "raw invalid name");
    projection.finish();

    const agent = sink.spans.find((span) => span.type === SpanType.AGENT_RUN);
    const tool = sink.spans.find((span) => span.type === SpanType.TOOL_CALL);
    expect(agent?.createOptions?.metadata).toEqual({
      "seqlane.adapter": "acp-v1",
    });
    expect(tool?.createOptions?.name).toBe("ACP v1 tool call");
    expect(tool?.createOptions?.attributes).toEqual({
      toolType: "tool",
      toolCallId: "raw-external-id",
    });
    expect(tool?.createOptions?.metadata).toEqual({
      "seqlane.attemptIndex": 0,
    });
    expect(tool?.createOptions).not.toHaveProperty("entityName");
    expect(tool?.createOptions).not.toHaveProperty("tags");
    expect(JSON.stringify(tool?.createOptions)).not.toContain(
      "raw invalid name",
    );
  });

  it.each(["end", "error"] as const)(
    "disables projection after a tool span %s failure without throwing",
    (failedOperation) => {
      let failureAvailable = true;
      const sink = spanSink((operation, type) => {
        if (
          failureAvailable &&
          operation === failedOperation &&
          type === SpanType.TOOL_CALL
        ) {
          failureAvailable = false;
          return true;
        }
        return false;
      });
      let diagnosticCalls = 0;
      const projection = createAcpObservability(
        { tracingContext: { currentSpan: sink.root } },
        "invocation",
        () => {
          diagnosticCalls += 1;
          throw new Error("diagnostic sink failed");
        },
      );
      const reducer = new AcpToolReducer("invocation", {
        onToolOpened: projection.onToolOpened,
        onToolClosed: projection.onToolClosed,
      });
      openTool(reducer, 0, "id", "tool");

      expect(() =>
        closeTool(
          reducer,
          0,
          "id",
          "tool",
          failedOperation === "error" ? true : undefined,
        ),
      ).not.toThrow();
      expect(() => projection.finish()).not.toThrow();
      expect(diagnosticCalls).toBe(1);
      expect(sink.closeOrder.at(-1)).toContain(SpanType.AGENT_RUN);
    },
  );

  it("makes absent, invalid, conflicting, and create-failing parents no-ops", () => {
    expect(() =>
      createAcpObservability({}, "invocation").finish(),
    ).not.toThrow();
    const invalid = {
      id: "invalid",
      isValid: false,
      createChildSpan: () => {
        throw new Error("must not create");
      },
    } as never;
    expect(() =>
      createAcpObservability(
        { tracingContext: { currentSpan: invalid } },
        "invocation",
      ).finish(),
    ).not.toThrow();

    const first = spanSink();
    const second = spanSink();
    (second.root as { id: string }).id = "other-workflow-step";
    const diagnostics: string[] = [];
    createAcpObservability(
      {
        tracingContext: { currentSpan: first.root },
        tracing: { currentSpan: second.root },
      },
      "invocation",
      (message) => diagnostics.push(message),
    ).finish();
    expect(first.spans).toHaveLength(1);

    const failingRoot = {
      id: "workflow",
      isValid: true,
      createChildSpan: () => {
        throw new Error("span create failed");
      },
    } as never;
    createAcpObservability(
      { tracingContext: { currentSpan: failingRoot } },
      "invocation",
      (message) => diagnostics.push(message),
    ).finish();
    expect(diagnostics).toEqual([
      "ACP v1 observability context had conflicting current spans",
      "ACP v1 native projection disabled after span create failure",
    ]);
  });

  it("enforces tool-record, activity, and activity-input limits across attempts", () => {
    const records = new AcpToolReducer("records", {});
    for (let index = 0; index < MAX_TOOL_RECORD_COUNT; index += 1) {
      openTool(records, index % 2, `id-${index}`, "tool");
    }
    expect(() => openTool(records, 2, "overflow", "tool")).toThrowError(
      expect.objectContaining({
        name: "AcpLimitError",
        resource: "tool record count",
        maximum: MAX_TOOL_RECORD_COUNT,
      }),
    );

    const activities = new AcpToolReducer("activities", {});
    openTool(activities, 0, "id", "tool");
    for (let index = 1; index < MAX_ACTIVITY_COUNT; index += 1) {
      openTool(activities, 0, "id", "tool");
    }
    expect(() => openTool(activities, 1, "id", "tool")).toThrowError(
      expect.objectContaining({
        name: "AcpLimitError",
        resource: "activity count",
        maximum: MAX_ACTIVITY_COUNT,
      }),
    );

    const input = new AcpToolReducer("input", {});
    const half = MAX_ACTIVITY_INPUT_LENGTH / 2;
    openTool(input, 0, "id", "tool", "x".repeat(half));
    openTool(input, 0, "id", "tool", "x".repeat(half));
    expect(() => openTool(input, 1, "id", "tool", "x")).toThrowError(
      expect.objectContaining({
        name: "AcpLimitError",
        resource: "activity input",
        maximum: MAX_ACTIVITY_INPUT_LENGTH,
      }),
    );
  });

  it("routes the compatibility helper through canonical lifecycle and bounds", () => {
    const activities = new Map<string, string>();
    const observed: unknown[] = [];
    const report = (value: unknown) =>
      reportAcpStreamChunk(value, activities, (activity) =>
        observed.push(activity),
      );

    report({
      type: "tool-call-delta",
      payload: { toolCallId: "id", toolName: "tool" },
    });
    report({
      type: "tool-call-delta",
      payload: { toolCallId: "id", toolName: "tool" },
    });
    report({
      type: "tool-result",
      payload: { toolCallId: "id", toolName: "tool" },
    });
    report({
      type: "tool-result",
      payload: { toolCallId: "id", toolName: "tool" },
    });

    expect(activities).toEqual(new Map([["id", "tool"]]));
    expect(observed).toEqual([
      expect.objectContaining({ state: "started" }),
      expect.objectContaining({ state: "progress" }),
      expect.objectContaining({ state: "succeeded" }),
    ]);

    const full = new Map(
      Array.from({ length: MAX_TOOL_RECORD_COUNT }, (_, index) => [
        `id-${index}`,
        "tool",
      ]),
    );
    expect(() =>
      reportAcpStreamChunk(
        {
          type: "tool-call-delta",
          payload: { toolCallId: "overflow", toolName: "tool" },
        },
        full,
        undefined,
      ),
    ).toThrowError(
      expect.objectContaining({
        resource: "tool record count",
        maximum: MAX_TOOL_RECORD_COUNT,
      }),
    );
  });
});
