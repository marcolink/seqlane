// @test-scope ./ci-renderer.ts
// @test-scope ./output-details.ts

import type { SeqlaneExecutionEvent } from "@seqlane/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CIRenderer, isCIOutput } from "./ci-renderer.js";
import type { OutputCapabilities, OutputSink } from "./renderer-contract.js";

class RecordingSink implements OutputSink {
  readonly writes: string[] = [];
  readonly shouldFail: boolean;

  constructor(shouldFail = false) {
    this.shouldFail = shouldFail;
  }

  write(value: string): void {
    if (this.shouldFail) throw new Error("sink failed");
    this.writes.push(value);
  }

  async flush(): Promise<void> {
    await Promise.resolve();
  }
}

const run = {
  workId: "work-1",
  runId: "run-1",
  metadata: {
    schemaVersion: 1 as const,
    eventId: "test-event",
    sequence: 1,
    occurredAt: "2026-08-18T00:00:00.000Z",
  },
};

function capabilities(
  stdout = new RecordingSink(),
  summary = new RecordingSink(),
  annotations?: OutputSink,
): OutputCapabilities {
  return {
    isTTY: false,
    supportsAnsi: false,
    supportsUnicode: false,
    width: 80,
    stdout,
    stderr: new RecordingSink(),
    summary,
    ...(annotations === undefined ? {} : { githubActions: { annotations } }),
  };
}

function created(
  invocationId: string,
  label: string,
  siblingOrder: number,
  parentInvocationId?: string,
  kind: "workflow" | "loop" | "task" = "task",
): SeqlaneExecutionEvent {
  return {
    type: "invocation.created",
    ...run,
    invocationId,
    planNodeId: invocationId,
    subject: { type: "task", taskId: label },
    taskId: label,
    kind,
    label,
    siblingOrder,
    dependencyIds: [],
    ...(parentInvocationId === undefined ? {} : { parentInvocationId }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("CI renderer", () => {
  it("emits bold task lifecycle lines with duration and token details", async () => {
    const stdout = new RecordingSink();
    const renderer = new CIRenderer(capabilities(stdout), {
      heartbeatIntervalMs: 0,
      redactions: ["top-secret-value"],
    });
    renderer.handle({ type: "run.started", ...run });
    renderer.handle(created("a", "Parallel A", 0));
    renderer.handle(created("b", "Parallel B", 1));
    renderer.handle({
      type: "invocation.started",
      ...run,
      invocationId: "a",
      subject: { type: "task", taskId: "Parallel A" },
      taskId: "Parallel A",
    });
    renderer.handle({
      type: "invocation.progress",
      ...run,
      invocationId: "a",
      state: "active",
      phase: "execute",
      message: "working",
    });
    renderer.handle({
      type: "invocation.output",
      ...run,
      metadata: { ...run.metadata, occurredAt: "2026-08-18T00:00:01.000Z" },
      invocationId: "a",
      policy: "persistent",
      channel: "task",
      content: "checkpoint",
      metrics: {
        cost: 0.0042,
        tokens: {
          total: 42,
          input: 20,
          output: 12,
          reasoning: 8,
          cacheRead: 2,
          cacheWrite: 0,
        },
      },
    });
    renderer.handle({
      type: "invocation.succeeded",
      ...run,
      metadata: { ...run.metadata, occurredAt: "2026-08-18T00:00:02.000Z" },
      invocationId: "a",
    });
    renderer.handle({
      type: "run.succeeded",
      ...run,
      metadata: { ...run.metadata, occurredAt: "2026-08-18T00:00:03.000Z" },
      output: null,
    });
    await renderer.finish();

    const output = stdout.writes.join("");
    expect(isCIOutput(output)).toBe(true);
    expect(output).toContain("invocation=a");
    expect(output).toContain("\u001b[1mrun=run-1 invocation=a started");
    expect(output).toContain(
      "\u001b[1mrun=run-1 invocation=a succeeded label=Parallel A duration=2000ms tokens=42 inputTokens=20 outputTokens=12 reasoning=8 cacheRead=2 cacheWrite=0 cost=0.0042\u001b[0m",
    );
    expect(output).toContain(
      "task-duration run=run-1 invocation=a label=Parallel A state=succeeded duration=2.0s cost=0.0042",
    );
    expect(output).toContain("summary run=run-1 outcome=succeeded");
    expect(output).toContain("cost=0.0042");
    expect(renderer.summary).toMatchObject({
      totalCost: 0.0042,
      taskDurations: [{ invocationId: "a", cost: 0.0042 }],
    });
  });

  it("includes loop parents and body iterations in CI lines", () => {
    const stdout = new RecordingSink();
    const renderer = new CIRenderer(capabilities(stdout), {
      heartbeatIntervalMs: 0,
    });
    renderer.handle({ type: "run.started", ...run });
    renderer.handle(created("loop", "repeat:1", 0, undefined, "loop"));
    renderer.handle(created("body", "body", 0, "loop"));
    renderer.handle({
      type: "invocation.started",
      ...run,
      invocationId: "body",
      subject: { type: "task", taskId: "body" },
      taskId: "body",
      iteration: 2,
    });

    const output = stdout.writes.join("");
    expect(output).toContain("parent=loop");
    expect(output).toContain("iteration=2");
  });

  it("suppresses routine tool and skill activity lines", () => {
    const stdout = new RecordingSink();
    const renderer = new CIRenderer(capabilities(stdout), {
      heartbeatIntervalMs: 0,
    });
    renderer.handle({ type: "run.started", ...run });
    renderer.handle(created("a", "Task A", 0));
    renderer.handle({
      type: "invocation.activity",
      ...run,
      invocationId: "a",
      activityId: "call-1",
      kind: "tool",
      name: "filesystem.read",
      state: "succeeded",
    });

    renderer.handle({
      type: "invocation.activity",
      ...run,
      invocationId: "a",
      activityId: "skill-1",
      kind: "skill",
      name: "web-perf",
      state: "succeeded",
    });

    expect(stdout.writes.join("")).not.toContain("filesystem.read");
  });

  it("logs the bounded command for failed tool activity", async () => {
    const stdout = new RecordingSink();
    const renderer = new CIRenderer(capabilities(stdout), {
      heartbeatIntervalMs: 0,
      redactions: ["top-secret-value"],
    });
    renderer.handle({ type: "run.started", ...run });
    renderer.handle(created("a", "Task A", 0));
    renderer.handle({
      type: "invocation.activity",
      ...run,
      invocationId: "a",
      activityId: "call-1",
      kind: "tool",
      name: "bash",
      state: "failed",
      input: {
        state: "present",
        value: {
          command: "printf top-secret-value",
          secret: "must not be emitted separately",
        },
      },
      message: "Tool failed: top-secret-value",
    });
    await renderer.finish();

    const output = stdout.writes.join("");
    expect(output).toContain(
      "activity=bash command=printf *** failed error=Tool failed: ***",
    );
    expect(output).not.toContain("top-secret-value");
    expect(output).not.toContain("must not be emitted separately");
  });

  it("logs the bounded path for failed read activity", async () => {
    const stdout = new RecordingSink();
    const renderer = new CIRenderer(capabilities(stdout), {
      heartbeatIntervalMs: 0,
    });
    renderer.handle({ type: "run.started", ...run });
    renderer.handle(created("a", "Task A", 0));
    renderer.handle({
      type: "invocation.activity",
      ...run,
      invocationId: "a",
      activityId: "call-1",
      kind: "tool",
      name: "read",
      state: "failed",
      input: {
        state: "present",
        value: {
          filePath: "/repo/src/review.ts",
          offset: 1,
          limit: 200,
        },
      },
      message: "Tool failed",
    });
    await renderer.finish();

    expect(stdout.writes.join("")).toContain(
      "activity=read path=/repo/src/review.ts failed error=Tool failed",
    );
  });

  it("emits a heartbeat while active", () => {
    vi.useFakeTimers();
    const stdout = new RecordingSink();
    const renderer = new CIRenderer(capabilities(stdout), {
      now: () => new Date("2026-08-18T00:00:00.000Z"),
      heartbeatIntervalMs: 1000,
    });
    renderer.handle({ type: "run.started", ...run });
    vi.advanceTimersByTime(1000);

    expect(stdout.writes.join("")).toContain("heartbeat run=run-1");
  });

  it("retains retry, skip, and persistent output details", async () => {
    const stdout = new RecordingSink();
    const summary = new RecordingSink();
    const renderer = new CIRenderer(capabilities(stdout, summary), {
      heartbeatIntervalMs: 0,
    });
    renderer.handle({ type: "run.started", ...run });
    renderer.handle(created("a", "Task A", 0));
    renderer.handle(created("b", "Task B", 1));
    renderer.handle({
      type: "invocation.retrying",
      ...run,
      invocationId: "a",
      attempt: 2,
      maximumAttempts: 3,
      nextAttemptAt: "2026-08-18T00:00:01.000Z",
      lastError: { category: "ExecutorError", message: "retryable" },
    });
    renderer.handle({
      type: "invocation.output",
      ...run,
      invocationId: "a",
      policy: "persistent",
      channel: "task",
      content: "checkpoint",
      metrics: {
        durationMs: 1250,
        model: "fake-model",
        provider: "fake-provider",
        modelSelection: {
          model: { provider: "openai", model: "gpt-5.2" },
          reasoning: "high",
        },
        cost: 0.0042,
        tokens: {
          total: 42,
          input: 20,
          output: 12,
          reasoning: 8,
          cacheRead: 2,
          cacheWrite: 0,
        },
      },
      summary: { kind: "object", size: 2, fields: ["files", "summary"] },
    });
    renderer.handle({
      type: "invocation.skipped",
      ...run,
      invocationId: "b",
      reason: "dependency A failed",
      dependencyIds: ["a"],
    });
    renderer.handle({
      type: "run.failed",
      ...run,
      error: { category: "RuntimeError", message: "run failed" },
    });
    await renderer.finish();

    const output = stdout.writes.join("");
    expect(output).toContain("retry attempt=2/3");
    expect(output).toContain("output=checkpoint");
    expect(output).toContain("model=fake-model");
    expect(output).toContain("selection=openai/gpt-5.2");
    expect(output).toContain("reasoning=high");
    expect(output).toContain("tokens=42");
    expect(output).toContain("summary=object");
    expect(output).toContain("reason=dependency A failed");
    expect(renderer.summary).toMatchObject({
      outcome: "failed",
      counts: { failed: 0, skipped: 1 },
    });
    expect(summary.writes.join("")).toContain("Seqlane execution");
  });

  it("produces nested failure details in the final summary", async () => {
    const summary = new RecordingSink();
    const renderer = new CIRenderer(
      capabilities(new RecordingSink(), summary),
      {
        heartbeatIntervalMs: 0,
      },
    );
    renderer.handle({ type: "run.started", ...run });
    renderer.handle(created("workflow", "Nested", 0, undefined, "workflow"));
    renderer.handle(created("task", "Nested task", 0, "workflow"));
    renderer.handle({
      type: "invocation.failed",
      ...run,
      invocationId: "task",
      disposition: "fail_run",
      error: { category: "ExecutorError", message: "redacted failure" },
    });
    renderer.handle({
      type: "run.failed",
      ...run,
      error: { category: "ExecutorError", message: "redacted failure" },
    });
    await renderer.finish();

    expect(summary.writes.join("")).toContain("Nested task");
    expect(summary.writes.join("")).toContain("redacted failure");
    expect(summary.writes.join("")).toContain("### Task durations");
    expect(renderer.summary?.counts.failed).toBe(1);
  });

  it("isolates sink failures from the execution result", () => {
    const renderer = new CIRenderer(capabilities(new RecordingSink(true)), {
      heartbeatIntervalMs: 0,
    });

    expect(() =>
      renderer.handle({ type: "run.started", ...run }),
    ).not.toThrow();
    expect(renderer.lastError).toBeInstanceOf(Error);
  });

  it("renders validation identity, verdict, issues, and bounded evidence", async () => {
    const stdout = new RecordingSink();
    const renderer = new CIRenderer(capabilities(stdout), {
      heartbeatIntervalMs: 0,
    });
    renderer.handle({ type: "run.started", ...run });
    renderer.handle({
      type: "invocation.created",
      ...run,
      invocationId: "validation-gate",
      planNodeId: "validation.gate:1",
      subject: { type: "validation-gate", planNodeId: "validation.gate:1" },
      kind: "validation",
      label: "Validate result",
      siblingOrder: 0,
      dependencyIds: [],
    });
    renderer.handle({
      type: "invocation.failed",
      ...run,
      invocationId: "validation-gate",
      disposition: "fail_run",
      error: {
        category: "ValidationError",
        message: "Validation failed",
        validation: {
          validationNodeId: "validation.gate:1",
          sourceId: "release-ready",
          issues: [{ code: "unsafe", message: "Unsafe result" }],
          evidence: { state: "redacted" },
        },
      },
    });
    await renderer.finish();

    const output = stdout.writes.join("");
    expect(output).toContain("validation source=release-ready");
    expect(output).toContain("verdict=failed");
    expect(output).toContain("issues=unsafe: Unsafe result");
    expect(output).toContain("evidence=redacted");
  });

  it("renders failures as escaped GitHub annotations", () => {
    const stdout = new RecordingSink();
    const annotations = new RecordingSink();
    const renderer = new CIRenderer(
      capabilities(stdout, new RecordingSink(), annotations),
      { heartbeatIntervalMs: 0 },
    );
    renderer.handle({ type: "run.started", ...run });
    renderer.handle(created("a", "Task A", 0));
    renderer.handle({
      type: "invocation.failed",
      ...run,
      invocationId: "a",
      disposition: "fail_run",
      error: {
        category: "ExecutorError",
        message: "line one\nline two: 100%, ready",
      },
    });
    renderer.handle({
      type: "run.failed",
      ...run,
      error: { category: "RuntimeError", message: "run failed" },
    });

    const output = annotations.writes.join("");
    expect(output).toContain("::error title=Seqlane invocation failed::");
    expect(output).toContain("%25");
    expect(output).toContain("%3A");
    expect(output).toContain("%2C");
    expect(output).toContain("::error title=Seqlane run failed::");
  });

  it("does not print input, transient output, or multiline content", () => {
    const stdout = new RecordingSink();
    const renderer = new CIRenderer(capabilities(stdout), {
      heartbeatIntervalMs: 0,
    });
    renderer.handle({ type: "run.started", ...run });
    renderer.handle(created("a", "Task A", 0));
    renderer.handle({
      type: "invocation.input",
      ...run,
      invocationId: "a",
      input: { state: "present", value: "secret input" },
    });
    renderer.handle({
      type: "invocation.output",
      ...run,
      invocationId: "a",
      policy: "transient",
      channel: "task",
      content: "transient secret",
    });
    renderer.handle({
      type: "invocation.output",
      ...run,
      invocationId: "a",
      policy: "persistent",
      channel: "task",
      content: "\u001b[31mline one\u001b[0m\nline two",
    });

    const output = stdout.writes.join("");
    expect(output).not.toContain("secret input");
    expect(output).not.toContain("transient secret");
    expect(output).toContain("output=line one line two");
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("line one\nline two");
  });

  it("includes run-level failures in the final summary", async () => {
    const summary = new RecordingSink();
    const renderer = new CIRenderer(
      capabilities(new RecordingSink(), summary),
      { heartbeatIntervalMs: 0 },
    );
    renderer.handle({ type: "run.started", ...run });
    renderer.handle({
      type: "run.failed",
      ...run,
      error: { category: "RuntimeError", message: "runner unavailable" },
    });
    await renderer.finish();

    expect(summary.writes.join("")).toContain("### Run error");
    expect(summary.writes.join("")).toContain("runner unavailable");
    expect(renderer.summary?.runError).toEqual({
      category: "RuntimeError",
      message: "runner unavailable",
    });
  });

  it("renders runner supervision failures in the final summary", async () => {
    const stdout = new RecordingSink();
    const annotations = new RecordingSink();
    const summary = new RecordingSink();
    const renderer = new CIRenderer(
      capabilities(stdout, summary, annotations),
      { heartbeatIntervalMs: 0 },
    );
    renderer.handle({ type: "run.started", ...run });
    renderer.handleRunnerFailure({
      message: "runner exited before terminal event",
    });
    await renderer.finish();

    expect(stdout.writes.join("")).toContain(
      "run=run-1 failed category=RuntimeError error=runner exited before terminal event",
    );
    expect(summary.writes.join("")).toContain("Outcome: failed");
    expect(annotations.writes.join("")).toContain(
      "::error title=Seqlane runner failed::",
    );
  });
});
