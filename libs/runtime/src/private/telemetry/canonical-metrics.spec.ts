// @test-scope ./canonical-metrics.ts
import { describe, expect, it } from "vitest";
import { seqlaneExecutionEventSchema } from "@seqlane/protocol";
import {
  createCanonicalMetricRegistry,
  recordCanonicalMetric,
  recordQueuePressureMetrics,
  snapshotCanonicalMetrics,
} from "./canonical-metrics.js";

function event(value: unknown) {
  return seqlaneExecutionEventSchema.parse(value);
}

function metadata(sequence: number, second: number) {
  return {
    schemaVersion: 1,
    eventId: `event-${sequence}`,
    sequence,
    occurredAt: `2026-10-21T10:00:${String(second).padStart(2, "0")}.000Z`,
  } as const;
}

function metricRows(
  registry: ReturnType<typeof createCanonicalMetricRegistry>,
) {
  return snapshotCanonicalMetrics(registry);
}

function row(
  rows: ReturnType<typeof metricRows>,
  name: string,
  attributes: Readonly<Record<string, string>> = {},
) {
  return rows.find(
    (candidate) =>
      candidate.name === name &&
      Object.entries(attributes).every(
        ([key, value]) => candidate.attributes[key] === value,
      ),
  );
}

describe("canonical Effect metrics", () => {
  it("records bounded queue counters and gauges in the native registry", () => {
    const registry = createCanonicalMetricRegistry();
    recordQueuePressureMetrics(registry, {
      maxPendingBytes: 16,
      pendingBytesPeak: 12,
      capacityWaitsTotal: 3,
      overflowsTotal: 1,
    });

    const rows = snapshotCanonicalMetrics(registry);
    expect(row(rows, "seqlane.event_queue.capacity_waits")?.value).toBe(3);
    expect(row(rows, "seqlane.event_queue.overflows")?.value).toBe(1);
    expect(row(rows, "seqlane.event_queue.pending_bytes_peak")).toMatchObject({
      value: 12,
      kind: "gauge",
    });
    expect(row(rows, "seqlane.event_queue.capacity_bytes")).toMatchObject({
      value: 16,
      kind: "gauge",
    });
  });

  it("records terminal outcomes, durations, waits, and retries from canonical events", () => {
    const registry = createCanonicalMetricRegistry();
    recordCanonicalMetric(
      registry,
      event({
        type: "invocation.created",
        metadata: metadata(1, 0),
        workId: "work",
        runId: "run",
        invocationId: "invocation-private-id",
        planNodeId: "task-private-id",
        subject: { type: "task", taskId: "task-private-id" },
        kind: "task",
        label: "task",
        siblingOrder: 0,
        dependencyIds: [],
      }),
    );
    recordCanonicalMetric(
      registry,
      event({
        type: "invocation.progress",
        metadata: { ...metadata(2, 0), occurredAt: "2026-10-21T10:00:00.250Z" },
        workId: "work",
        runId: "run",
        invocationId: "invocation-private-id",
        state: "waiting",
        phase: "workspace",
        waitingReason: "shared_workspace_busy",
      }),
    );
    recordCanonicalMetric(
      registry,
      event({
        type: "invocation.started",
        metadata: metadata(3, 1),
        workId: "work",
        runId: "run",
        invocationId: "invocation-private-id",
        subject: { type: "task", taskId: "task-private-id" },
        taskId: "task-private-id",
      }),
    );
    recordCanonicalMetric(
      registry,
      event({
        type: "invocation.progress",
        metadata: { ...metadata(4, 1), occurredAt: "2026-10-21T10:00:01.000Z" },
        workId: "work",
        runId: "run",
        invocationId: "invocation-private-id",
        state: "active",
        phase: "execution",
      }),
    );
    recordCanonicalMetric(
      registry,
      event({
        type: "invocation.retrying",
        metadata: metadata(5, 1),
        workId: "work",
        runId: "run",
        invocationId: "invocation-private-id",
        attempt: 1,
        delayMs: 10,
        lastError: { category: "RuntimeError", message: "private error text" },
      }),
    );
    recordCanonicalMetric(
      registry,
      event({
        type: "invocation.succeeded",
        metadata: metadata(6, 2),
        workId: "work",
        runId: "run",
        invocationId: "invocation-private-id",
      }),
    );

    const rows = metricRows(registry);
    expect(
      row(rows, "seqlane.invocations", {
        task_kind: "task",
        outcome: "succeeded",
      })?.value,
    ).toBe(1);
    expect(
      row(rows, "seqlane.invocation.duration_ms_sum", {
        task_kind: "task",
        outcome: "succeeded",
      })?.value,
    ).toBe(1_000);
    expect(
      row(rows, "seqlane.invocation.wait_duration_ms_sum", {
        task_kind: "task",
      })?.value,
    ).toBe(750);
    expect(
      row(rows, "seqlane.invocation.retries", { task_kind: "task" })?.value,
    ).toBe(1);
    expect(
      row(rows, "seqlane.invocation.retry_delay_ms_sum", { task_kind: "task" })
        ?.value,
    ).toBe(10);
    expect(JSON.stringify(rows)).not.toContain("invocation-private-id");
    expect(JSON.stringify(rows)).not.toContain("task-private-id");
    expect(JSON.stringify(rows)).not.toContain("private error text");
  });

  it("closes an admission wait at started when no later progress event arrives", () => {
    const registry = createCanonicalMetricRegistry();
    const invocationId = "waiting-invocation";
    recordCanonicalMetric(
      registry,
      event({
        type: "invocation.created",
        metadata: metadata(1, 0),
        workId: "work",
        runId: "run",
        invocationId,
        planNodeId: "task",
        subject: { type: "task", taskId: "task" },
        kind: "task",
        label: "task",
        siblingOrder: 0,
        dependencyIds: [],
      }),
    );
    recordCanonicalMetric(
      registry,
      event({
        type: "invocation.progress",
        metadata: { ...metadata(2, 0), occurredAt: "2026-10-21T10:00:00.500Z" },
        workId: "work",
        runId: "run",
        invocationId,
        state: "waiting",
        phase: "admission",
        waitingReason: "workspace_unavailable",
      }),
    );
    recordCanonicalMetric(
      registry,
      event({
        type: "invocation.started",
        metadata: metadata(3, 1),
        workId: "work",
        runId: "run",
        invocationId,
        subject: { type: "task", taskId: "task" },
      }),
    );
    recordCanonicalMetric(
      registry,
      event({
        type: "invocation.succeeded",
        metadata: metadata(4, 5),
        workId: "work",
        runId: "run",
        invocationId,
      }),
    );

    const rows = metricRows(registry);
    expect(
      row(rows, "seqlane.invocation.wait_duration_ms_sum", {
        task_kind: "task",
      })?.value,
    ).toBe(500);
  });

  it("records normalized zero and fractional call metrics once and deduplicates observation terminals", () => {
    const registry = createCanonicalMetricRegistry();
    const invocationId = "private-invocation";
    recordCanonicalMetric(
      registry,
      event({
        type: "invocation.started",
        metadata: metadata(1, 0),
        workId: "work",
        runId: "run",
        invocationId,
        subject: { type: "task", taskId: "task-id" },
      }),
    );
    recordCanonicalMetric(
      registry,
      event({
        type: "invocation.output",
        metadata: metadata(2, 0),
        workId: "work",
        runId: "run",
        invocationId,
        policy: "transient",
        channel: "task",
        content: "early output before summary metrics",
      }),
    );
    const output = event({
      type: "invocation.output",
      metadata: metadata(3, 0),
      workId: "work",
      runId: "run",
      invocationId,
      policy: "transient",
      channel: "task",
      content: "complete",
      metrics: {
        durationMs: 0,
        cost: 0.125,
        tokens: {
          input: 0,
          output: 7,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 2,
          total: 9,
        },
        modelSelection: {
          model: { provider: "private-provider", model: "private-model" },
        },
      },
    });
    recordCanonicalMetric(registry, output);
    recordCanonicalMetric(registry, { ...output, metadata: metadata(4, 0) });
    const observation = {
      type: "invocation.observation" as const,
      metadata: metadata(5, 0),
      workId: "work",
      runId: "run",
      invocationId,
      observationId: "private-observation",
      kind: "model" as const,
      state: "started" as const,
      attemptIndex: 1,
      model: {
        operation: "model.generate",
        provider: "attacker-provider-label",
        model: "attacker-model-label",
        startedAt: Date.parse("2026-10-21T10:00:00.000Z"),
        usage: { inputTokens: 999 },
        cost: 999,
      },
    };
    recordCanonicalMetric(registry, event(observation));
    const terminal = event({
      ...observation,
      metadata: metadata(6, 1),
      state: "succeeded",
      model: {
        ...observation.model,
        endedAt: Date.parse("2026-10-21T10:00:01.000Z"),
      },
    });
    recordCanonicalMetric(registry, terminal);
    recordCanonicalMetric(registry, { ...terminal, metadata: metadata(7, 1) });
    recordCanonicalMetric(
      registry,
      event({
        ...observation,
        metadata: metadata(8, 1),
        attemptIndex: 2,
        model: {
          ...observation.model,
          startedAt: Date.parse("2026-10-21T10:00:01.000Z"),
        },
      }),
    );
    recordCanonicalMetric(
      registry,
      event({
        ...observation,
        metadata: { ...metadata(9, 1), occurredAt: "2026-10-21T10:00:01.500Z" },
        state: "succeeded",
        attemptIndex: 2,
        model: {
          ...observation.model,
          startedAt: Date.parse("2026-10-21T10:00:01.000Z"),
          endedAt: Date.parse("2026-10-21T10:00:01.500Z"),
        },
      }),
    );
    recordCanonicalMetric(
      registry,
      event({
        type: "invocation.succeeded",
        metadata: metadata(10, 1),
        workId: "work",
        runId: "run",
        invocationId,
      }),
    );

    const rows = metricRows(registry);
    expect(row(rows, "seqlane.model.cost", { task_kind: "task" })?.value).toBe(
      0.125,
    );
    expect(
      row(rows, "seqlane.model.tokens", {
        task_kind: "task",
        token_type: "input",
      })?.value,
    ).toBe(0);
    expect(
      row(rows, "seqlane.model.tokens", {
        task_kind: "task",
        token_type: "output",
      })?.value,
    ).toBe(7);
    expect(
      row(rows, "seqlane.model.tokens", {
        task_kind: "task",
        token_type: "cache_write",
      })?.value,
    ).toBe(2);
    expect(
      row(rows, "seqlane.invocation.reported_duration_ms_sum", {
        task_kind: "task",
      })?.value,
    ).toBe(0);
    expect(
      row(rows, "seqlane.invocation.reported_duration_ms_count", {
        task_kind: "task",
      })?.value,
    ).toBe(1);
    expect(
      row(rows, "seqlane.model.exchanges", { task_kind: "task" })?.value,
    ).toBe(2);
    expect(
      row(rows, "seqlane.model.exchange_outcomes", {
        task_kind: "task",
        outcome: "succeeded",
      })?.value,
    ).toBe(2);
    expect(
      row(rows, "seqlane.model.exchange.duration_ms_sum", {
        task_kind: "task",
        outcome: "succeeded",
      })?.value,
    ).toBe(1_500);
    expect(JSON.stringify(rows)).not.toMatch(
      /private-(?:invocation|observation|provider|model)/,
    );
    expect(JSON.stringify(rows)).not.toContain("attacker-provider-label");
    expect(JSON.stringify(rows)).not.toContain("attacker-model-label");
  });

  it("does not bill ACP session usage and uses an explicit encoded UTF-8 byte count", () => {
    const registry = createCanonicalMetricRegistry();
    const usage = event({
      type: "invocation.observation",
      metadata: metadata(1, 0),
      workId: "work",
      runId: "run",
      invocationId: "invocation",
      observationId: "usage",
      kind: "model",
      state: "succeeded",
      model: {
        operation: "acp.session.usage",
        usage: { inputTokens: 12, outputTokens: 3, contextWindow: 1_000 },
        cost: 0,
      },
    });
    recordCanonicalMetric(registry, usage);
    recordCanonicalMetric(
      registry,
      event({
        type: "run.heartbeat",
        metadata: metadata(2, 0),
        workId: "work",
        runId: "run",
        activeInvocationIds: [],
        elapsedMs: 0,
      }),
      Buffer.byteLength("é🧪", "utf8"),
    );

    const rows = metricRows(registry);
    expect(
      rows.filter((candidate) => candidate.name.startsWith("seqlane.model.")),
    ).toEqual([]);
    expect(row(rows, "seqlane.event.payload_bytes")?.value).toBe(6);
  });

  it("counts bounded omissions when invocation IDs cannot be tracked", () => {
    const registry = createCanonicalMetricRegistry();
    const invocationId = "x".repeat(513);
    recordCanonicalMetric(
      registry,
      event({
        type: "invocation.created",
        metadata: metadata(1, 0),
        workId: "work",
        runId: "run",
        invocationId,
        planNodeId: "task",
        subject: { type: "task", taskId: "task" },
        kind: "task",
        label: "task",
        siblingOrder: 0,
        dependencyIds: [],
      }),
    );

    const rows = metricRows(registry);
    expect(
      row(rows, "seqlane.telemetry.omissions", {
        reason: "invocation_id_untrackable",
      })?.value,
    ).toBe(1);
    expect(JSON.stringify(rows)).not.toContain(invocationId);
  });
});
