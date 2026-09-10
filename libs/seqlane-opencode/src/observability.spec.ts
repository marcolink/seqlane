// @test-scope ./observability.ts
// @test-scope ./observations.ts
// @test-scope ./attempt-transitions.ts
import { describe, expect, it, vi } from "vitest";
import { SpanType } from "@mastra/core/observability";
import { createAttemptTransitionDispatcher } from "./attempt-transitions.js";
import { createOpenCodeObservability } from "./observability.js";
import type {
  OpenCodeAssistantObservation,
  OpenCodeToolObservation,
} from "./observations.js";

function assistant(
  overrides: Partial<OpenCodeAssistantObservation> = {},
): OpenCodeAssistantObservation {
  return {
    kind: "assistant",
    sessionID: "session-1",
    messageID: "message-1",
    created: 100,
    completed: 120,
    provider: "provider",
    model: "model",
    tokens: {
      input: 3,
      output: 5,
      reasoning: 2,
      cacheRead: 1,
      cacheWrite: 0,
    },
    cost: 0.1,
    ...overrides,
  };
}

function tool(
  overrides: Partial<OpenCodeToolObservation> = {},
): OpenCodeToolObservation {
  return {
    kind: "tool",
    sessionID: "session-1",
    messageID: "message-1",
    callID: "call-1",
    tool: "filesystem.read",
    status: "completed",
    ...overrides,
  };
}

type SpanOptions = {
  type: SpanType;
  name?: string;
  attributes?: unknown;
  metadata?: unknown;
};

type SpanRecord = SpanOptions & {
  id: string;
  parent: unknown;
  updates: unknown[];
  ended: boolean;
  error?: unknown;
};

function spanFactory(idPrefix = "") {
  const lifecycle: string[] = [];
  let failNextUpdate = false;
  let failNextEnd = false;
  let failNextError = false;
  const spans: SpanRecord[] = [];
  const makeSpan = (
    type: SpanType,
    parent?: unknown,
    options: SpanOptions = { type },
  ) => {
    const id = `${idPrefix}${type}-${spans.length}`;
    const record: SpanRecord = {
      id,
      parent,
      ...options,
      type,
      updates: [],
      ended: false,
    };
    const span = {
      id,
      isValid: true,
      createChildSpan: (options: SpanOptions) =>
        makeSpan(options.type, span, options),
      update: (options: unknown) => {
        if (failNextUpdate) {
          failNextUpdate = false;
          throw new Error("exporter unavailable");
        }
        record.updates.push(options);
      },
      end: () => {
        if (failNextEnd) {
          failNextEnd = false;
          throw new Error("exporter unavailable");
        }
        record.ended = true;
        lifecycle.push(`end:${id}`);
      },
      error: (value: unknown) => {
        if (failNextError) {
          failNextError = false;
          throw new Error("exporter unavailable");
        }
        record.ended = true;
        record.error = value;
        lifecycle.push(`error:${id}`);
      },
    };
    spans.push(record);
    return span;
  };
  // The sink implements only the span operations exercised by this adapter.
  return {
    spans,
    lifecycle,
    failNextUpdate: () => {
      failNextUpdate = true;
    },
    failNextEnd: () => {
      failNextEnd = true;
    },
    failNextError: () => {
      failNextError = true;
    },
    root: makeSpan(SpanType.WORKFLOW_STEP) as never,
  };
}

describe("OpenCode Mastra observability projection", () => {
  it("projects legacy MCP tool lifecycle events into a closed tool span", () => {
    const factory = spanFactory();
    const activities: unknown[] = [];
    const observations: unknown[] = [];
    const projector = createOpenCodeObservability(
      { tracingContext: { currentSpan: factory.root } },
      "invocation-1",
    );
    const dispatcher = createAttemptTransitionDispatcher({
      onActivity: (activity) => activities.push(activity),
      onObservation: (observation) => {
        observations.push(observation);
        projector.observe(observation);
      },
    });

    projector.observe(
      assistant({ messageID: "assistant-1", completed: undefined }),
    );
    dispatcher.legacyTool({
      sessionID: "session-1",
      messageID: "assistant-1",
      callID: "mcp-call-1",
      tool: "ripwire_grep",
      status: "called",
      input: { query: "secret-input" },
      metadata: { transcript: "secret-metadata" },
    });
    dispatcher.legacyTool({
      sessionID: "session-1",
      messageID: "assistant-1",
      callID: "mcp-call-1",
      status: "success",
      output: "secret-output",
    });

    const toolSpan = factory.spans.find(
      (span) => span.type === SpanType.TOOL_CALL,
    );
    const modelSpan = factory.spans.find(
      (span) => span.type === SpanType.MODEL_GENERATION,
    );
    expect(observations).toEqual([
      expect.objectContaining({
        kind: "tool",
        callID: "mcp-call-1",
        messageID: "assistant-1",
        tool: "ripwire_grep",
        status: "running",
      }),
      expect.objectContaining({
        kind: "tool",
        callID: "mcp-call-1",
        messageID: "assistant-1",
        tool: "ripwire_grep",
        status: "completed",
      }),
    ]);
    expect(toolSpan?.name).toBe("ripwire_grep");
    expect((toolSpan?.parent as { id?: string }).id).toBe(modelSpan?.id);
    expect(toolSpan?.ended).toBe(true);
    expect(activities).toEqual([
      expect.objectContaining({
        activityId: "mcp-call-1",
        name: "ripwire_grep",
        state: "started",
      }),
      expect.objectContaining({
        activityId: "mcp-call-1",
        name: "ripwire_grep",
        state: "succeeded",
      }),
    ]);
    expect(JSON.stringify(factory.spans)).not.toContain("secret-");
    projector.finish();
  });

  it("uses a normalized bounded tool name and namespaced agent metadata", () => {
    const factory = spanFactory();
    const projector = createOpenCodeObservability(
      { tracingContext: { currentSpan: factory.root } },
      "invocation-1",
    );

    projector.observe(assistant({ completed: undefined }));
    projector.observe(
      tool({
        tool: "ｅｃｈｏ",
        status: "running",
        input: { authorization: "secret-input" },
        output: "secret-output",
        metadata: { transcript: "secret-transcript" },
      }),
    );

    const agent = factory.spans.find(
      (span) => span.type === SpanType.AGENT_RUN,
    );
    const toolSpan = factory.spans.find(
      (span) => span.type === SpanType.TOOL_CALL,
    );
    expect(agent?.metadata).toEqual({
      "seqlane.invocationId": "invocation-1",
      "seqlane.adapter": "opencode",
    });
    expect(toolSpan?.name).toBe("echo");
    expect(toolSpan?.attributes).toEqual({
      toolType: "tool",
      toolCallId: "call-1",
    });
    expect(toolSpan?.metadata).toBeUndefined();
    expect(JSON.stringify(factory.spans)).not.toContain("secret-");
  });

  it("omits oversized invocation IDs instead of persisting a shared-prefix truncation", () => {
    const factory = spanFactory();
    const sharedPrefix = "x".repeat(128);
    const sourceIds = [
      `${sharedPrefix}-first-source-id`,
      `${sharedPrefix}-second-source-id`,
    ];

    for (const sourceId of sourceIds) {
      createOpenCodeObservability(
        { tracingContext: { currentSpan: factory.root } },
        sourceId,
      );
    }

    const agentSpans = factory.spans.filter(
      (span) => span.type === SpanType.AGENT_RUN,
    );
    expect(agentSpans).toHaveLength(2);
    for (const agent of agentSpans) {
      expect(agent.metadata).toEqual({ "seqlane.adapter": "opencode" });
    }
    const serializedSpans = JSON.stringify(agentSpans);
    for (const sourceId of sourceIds) {
      expect(serializedSpans).not.toContain(sourceId);
    }
  });

  it("falls back for invalid and over-budget tool names without disabling projection", () => {
    const factory = spanFactory();
    const diagnostics: string[] = [];
    const projector = createOpenCodeObservability(
      { tracingContext: { currentSpan: factory.root } },
      "invocation-1",
      (message) => diagnostics.push(message),
    );

    projector.observe(tool({ tool: "not valid", callID: "invalid" }));
    for (let index = 0; index < 130; index += 1) {
      projector.observe(
        tool({
          messageID: `message-${index}`,
          callID: `call-${index}`,
          tool: `tool-${index}`,
        }),
      );
    }

    const toolSpans = factory.spans.filter(
      (span) => span.type === SpanType.TOOL_CALL,
    );
    expect(toolSpans[0]?.name).toBe("OpenCode tool call");
    expect(toolSpans[128]?.name).toBe("tool-127");
    expect(toolSpans[129]?.name).toBe("OpenCode tool call");
    expect(diagnostics).toContain(
      "OpenCode tool name cardinality limit reached; using fallback name",
    );
  });

  it("deduplicates messages and tools, preserving native parentage", () => {
    const factory = spanFactory();
    const projector = createOpenCodeObservability(
      { tracingContext: { currentSpan: factory.root } },
      "invocation-1",
    );

    projector.observe(assistant({ completed: undefined }));
    projector.observe(assistant({ completed: 120 }));
    projector.observe(tool({ status: "running" }));
    projector.observe(tool({ status: "completed" }));
    projector.observeTerminal(assistant({ completed: 120 }));
    projector.finish();

    expect(
      factory.spans.filter((span) => span.type === SpanType.AGENT_RUN),
    ).toHaveLength(1);
    expect(
      factory.spans.filter((span) => span.type === SpanType.MODEL_GENERATION),
    ).toHaveLength(1);
    expect(
      factory.spans.filter((span) => span.type === SpanType.TOOL_CALL),
    ).toHaveLength(1);
    const toolSpan = factory.spans.find(
      (span) => span.type === SpanType.TOOL_CALL,
    );
    expect(toolSpan?.parent).toBeDefined();
    expect((toolSpan?.parent as { id?: string }).id).toBe(
      `${SpanType.MODEL_GENERATION}-2`,
    );
    expect(factory.spans.slice(1).every((span) => span.ended)).toBe(true);
    expect(factory.spans[0]?.ended).toBe(false);
  });

  it("keeps repair messages as separate model spans under one agent run", () => {
    const factory = spanFactory();
    const projector = createOpenCodeObservability(
      { tracingContext: { currentSpan: factory.root } },
      "invocation-1",
    );

    projector.observe(assistant({ messageID: "initial", completed: 120 }));
    projector.observe(
      assistant({ messageID: "repair", created: 200, completed: 220 }),
    );
    projector.finish();

    expect(
      factory.spans.filter((span) => span.type === SpanType.AGENT_RUN),
    ).toHaveLength(1);
    expect(
      factory.spans.filter((span) => span.type === SpanType.MODEL_GENERATION),
    ).toHaveLength(2);
  });

  it("keeps tracing disabled execution free of native spans", () => {
    const projector = createOpenCodeObservability({}, "invocation-1");
    expect(() => {
      projector.observe(assistant());
      projector.observeTerminal(assistant());
      projector.finish(new Error("later failure"));
    }).not.toThrow();
  });

  it("omits unverified cost context and diagnoses it once", () => {
    const factory = spanFactory();
    const diagnostics: string[] = [];
    const projector = createOpenCodeObservability(
      { tracing: { currentSpan: factory.root } },
      "invocation-1",
      (message) => diagnostics.push(message),
    );
    projector.observe(assistant({ completed: undefined }));
    projector.observe(assistant({ completed: 120 }));
    projector.finish();

    expect(diagnostics).toEqual([
      "OpenCode cost unit is not verified; omitted native cost context",
    ]);
    const model = factory.spans.find(
      (span) => span.type === SpanType.MODEL_GENERATION,
    );
    expect(JSON.stringify(model)).not.toContain("estimatedCost");
  });

  it("isolates span failures from projection", () => {
    const root = {
      id: "workflow",
      isValid: true,
      createChildSpan: vi.fn(() => {
        throw new Error("exporter unavailable");
      }),
    };
    const diagnostics: string[] = [];
    const projector = createOpenCodeObservability(
      { tracingContext: { currentSpan: root as never } },
      "invocation-1",
      (message) => diagnostics.push(message),
    );
    expect(() => {
      projector.observe(assistant());
      projector.finish();
    }).not.toThrow();
    expect(diagnostics).toContain(
      "OpenCode native agent span could not be created",
    );
  });

  it("disables projection after a span operation fails", () => {
    const factory = spanFactory();
    const diagnostics: string[] = [];
    const projector = createOpenCodeObservability(
      { tracingContext: { currentSpan: factory.root } },
      "invocation-1",
      (message) => diagnostics.push(message),
    );
    projector.observe(assistant({ completed: undefined }));
    factory.failNextUpdate();
    projector.observe(assistant({ messageID: "message-1" }));

    expect(
      factory.spans.filter((span) => span.type === SpanType.MODEL_GENERATION),
    ).toHaveLength(1);
    expect(diagnostics).toContain(
      "OpenCode native projection disabled after span update failure",
    );
  });

  it("retries closure of the failed record during disable cleanup", () => {
    const factory = spanFactory();
    const projector = createOpenCodeObservability(
      { tracingContext: { currentSpan: factory.root } },
      "invocation-1",
    );

    projector.observe(assistant({ completed: undefined }));
    factory.failNextError();
    projector.finish(new Error("later failure"));

    const model = factory.spans.find(
      (span) => span.type === SpanType.MODEL_GENERATION,
    );
    expect(model?.ended).toBe(true);
  });

  it("bounds distinct model identities", () => {
    const factory = spanFactory();
    const diagnostics: string[] = [];
    const projector = createOpenCodeObservability(
      { tracingContext: { currentSpan: factory.root } },
      "invocation-1",
      (message) => diagnostics.push(message),
    );

    for (let index = 0; index < 2_000; index += 1) {
      projector.observe(
        assistant({ messageID: `message-${index}`, completed: undefined }),
      );
    }

    expect(
      factory.spans.filter((span) => span.type === SpanType.MODEL_GENERATION),
    ).toHaveLength(1_024);
    expect(diagnostics).toContain(
      "OpenCode native projection disabled after span model identity limit failure",
    );
  });

  it("omits provider and model after the invocation cardinality budget", () => {
    const factory = spanFactory();
    const diagnostics: string[] = [];
    const projector = createOpenCodeObservability(
      { tracingContext: { currentSpan: factory.root } },
      "invocation-1",
      (message) => diagnostics.push(message),
    );

    for (let index = 0; index < 130; index += 1) {
      projector.observe(
        assistant({
          messageID: `message-${index}`,
          provider: `provider-${index}`,
          model: `model-${index}`,
          cost: undefined,
          completed: 120,
        }),
      );
    }

    const models = factory.spans.filter(
      (span) => span.type === SpanType.MODEL_GENERATION,
    );
    expect(models).toHaveLength(130);
    expect(models[127]?.attributes).toMatchObject({
      provider: "provider-127",
      model: "model-127",
    });
    expect(models[128]?.attributes).not.toHaveProperty("provider");
    expect(models[128]?.attributes).not.toHaveProperty("model");
    expect(diagnostics).toEqual([
      "OpenCode provider/model cardinality limit reached; omitted provider/model attributes",
    ]);
  });

  it("keeps one fallback and ignores later unmatched terminal identities", () => {
    const factory = spanFactory();
    const diagnostics: string[] = [];
    const projector = createOpenCodeObservability(
      { tracingContext: { currentSpan: factory.root } },
      "invocation-1",
      (message) => diagnostics.push(message),
    );

    projector.observeTerminal(assistant({ messageID: "terminal-1" }));
    projector.observeTerminal(assistant({ messageID: "terminal-2" }));
    projector.finish();

    expect(
      factory.spans.filter((span) => span.type === SpanType.MODEL_GENERATION),
    ).toHaveLength(1);
    expect(diagnostics).toContain(
      "ignored additional unmatched OpenCode terminal observation",
    );
    expect(factory.spans.slice(1).every((span) => span.ended)).toBe(true);
  });

  it("uses tuple identities when IDs contain delimiters", () => {
    const factory = spanFactory();
    const projector = createOpenCodeObservability(
      { tracingContext: { currentSpan: factory.root } },
      "invocation-1",
    );

    projector.observe(assistant({ sessionID: "session:a", messageID: "b" }));
    projector.observe(assistant({ sessionID: "session", messageID: "a:b" }));
    projector.observe(
      tool({ messageID: "message:a", callID: "b:c", status: "running" }),
    );
    projector.observe(
      tool({ messageID: "message", callID: "a:b:c", status: "running" }),
    );
    projector.observe(
      tool({
        sessionID: "another-session",
        messageID: "message",
        callID: "a:b:c",
        status: "running",
      }),
    );
    projector.finish();

    expect(
      factory.spans.filter((span) => span.type === SpanType.MODEL_GENERATION),
    ).toHaveLength(2);
    expect(
      factory.spans.filter((span) => span.type === SpanType.TOOL_CALL),
    ).toHaveLength(2);
  });

  it("bounds distinct tool identities and diagnoses once", () => {
    const factory = spanFactory();
    const diagnostics: string[] = [];
    const projector = createOpenCodeObservability(
      { tracingContext: { currentSpan: factory.root } },
      "invocation-1",
      (message) => diagnostics.push(message),
    );

    for (let index = 0; index < 3_000; index += 1) {
      projector.observe(
        tool({
          messageID: `message-${index}`,
          callID: `call-${index}`,
          status: "running",
        }),
      );
    }

    expect(
      factory.spans.filter((span) => span.type === SpanType.TOOL_CALL),
    ).toHaveLength(2_048);
    expect(diagnostics).toEqual([
      "OpenCode native projection disabled after span tool identity limit failure",
    ]);
    projector.observe(
      tool({ messageID: "after-limit", callID: "after-limit" }),
    );
    expect(
      factory.spans.filter((span) => span.type === SpanType.TOOL_CALL),
    ).toHaveLength(2_048);
  });

  it("sanitizes executor failure data before ending spans", () => {
    const factory = spanFactory();
    const sanitized = createOpenCodeObservability(
      { tracingContext: { currentSpan: factory.root } },
      "invocation-1",
    );
    sanitized.observe(assistant({ completed: undefined }));
    sanitized.finish(new Error("secret transcript and tool output"));

    const model = factory.spans.find(
      (span) => span.type === SpanType.MODEL_GENERATION,
    );
    const message = (
      model?.error as { error?: { message?: string } } | undefined
    )?.error?.message;
    expect(message).not.toContain("secret transcript");
    expect(message).toBe("OpenCode invocation failed");
  });

  it("closes open spans with bounded cancellation status", () => {
    const factory = spanFactory();
    const projector = createOpenCodeObservability(
      { tracingContext: { currentSpan: factory.root } },
      "invocation-1",
    );
    projector.observe(assistant({ completed: undefined }));
    projector.finish({ kind: "cancelled" });

    const model = factory.spans.find(
      (span) => span.type === SpanType.MODEL_GENERATION,
    );
    const message = (
      model?.error as { error?: { message?: string } } | undefined
    )?.error?.message;
    expect(message).toBe("OpenCode invocation cancelled");
    expect(factory.spans[0]?.ended).toBe(false);
  });

  it("maps typed model fields and excludes raw tool payloads from spans", () => {
    const factory = spanFactory();
    const projector = createOpenCodeObservability(
      { tracingContext: { currentSpan: factory.root } },
      "invocation-1",
    );

    projector.observe(assistant({ completed: undefined }));
    projector.observe(
      tool({
        messageID: "unobserved-message",
        status: "running",
        input: { authorization: "secret-input" },
        output: "secret-output",
        metadata: { transcript: "secret-transcript" },
      }),
    );
    projector.finish();

    const model = factory.spans.find(
      (span) => span.type === SpanType.MODEL_GENERATION,
    );
    const orphanTool = factory.spans.find(
      (span) => span.type === SpanType.TOOL_CALL,
    );
    const agent = factory.spans.find(
      (span) => span.type === SpanType.AGENT_RUN,
    );
    expect(model?.attributes).toMatchObject({
      provider: "provider",
      model: "model",
      usage: {
        inputTokens: 3,
        outputTokens: 5,
        inputDetails: { cacheRead: 1, cacheWrite: 0 },
        outputDetails: { reasoning: 2 },
      },
    });
    expect((orphanTool?.parent as { id?: string }).id).toBe(agent?.id);
    expect(JSON.stringify(factory.spans)).not.toContain("secret-");
  });

  it("makes conflicting tracing aliases a diagnosed no-op", () => {
    const first = spanFactory("first-");
    const second = spanFactory("second-");
    const diagnostics: string[] = [];
    const projector = createOpenCodeObservability(
      {
        tracingContext: { currentSpan: first.root },
        tracing: { currentSpan: second.root },
      },
      "invocation-1",
      (message) => diagnostics.push(message),
    );

    projector.observe(assistant());
    projector.finish();

    expect(first.spans).toHaveLength(1);
    expect(second.spans).toHaveLength(1);
    expect(diagnostics).toEqual([
      "OpenCode observability context had conflicting current spans",
    ]);
  });

  it("closes open descendants before the agent and preserves completed models", () => {
    const factory = spanFactory();
    const projector = createOpenCodeObservability(
      { tracingContext: { currentSpan: factory.root } },
      "invocation-1",
    );

    projector.observe(assistant({ completed: undefined }));
    projector.observe(tool({ status: "running" }));
    projector.observe(
      assistant({ messageID: "completed-repair", completed: 140 }),
    );
    const completedModel = factory.spans.find(
      (span) =>
        span.type === SpanType.MODEL_GENERATION &&
        span.id.endsWith(`${SpanType.MODEL_GENERATION}-4`),
    );
    projector.finish({ kind: "failed" });

    const closing = factory.lifecycle.slice(-3);
    expect(closing[0]).toContain(SpanType.TOOL_CALL);
    expect(closing[1]).toContain(SpanType.MODEL_GENERATION);
    expect(closing[2]).toContain(SpanType.AGENT_RUN);
    expect(completedModel?.error).toBeUndefined();
    expect(factory.spans[0]?.ended).toBe(false);
  });
});
