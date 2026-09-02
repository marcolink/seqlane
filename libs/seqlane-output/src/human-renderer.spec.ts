import type { SeqlaneExecutionEvent } from "@seqlane/events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HumanTTYRenderer } from "./human-renderer.js";
import type { OutputCapabilities, OutputSink } from "./renderer-contract.js";

class RecordingSink implements OutputSink {
  readonly writes: string[] = [];

  write(value: string): void {
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
  overrides: Partial<OutputCapabilities> = {},
): OutputCapabilities {
  const stdout = new RecordingSink();
  const stderr = new RecordingSink();
  return {
    isTTY: true,
    supportsAnsi: true,
    supportsUnicode: true,
    width: 80,
    stdout,
    stderr,
    ...overrides,
  };
}

function created(
  invocationId: string,
  label: string,
  siblingOrder: number,
  parentInvocationId?: string,
  kind: "workflow" | "task" = "task",
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

function latest(sink: RecordingSink): string {
  return sink.writes.at(-1) ?? "";
}

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;]*[A-Z]/g, "");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("human TTY renderer", () => {
  it("renders an ANSI session link inline when its task is created later", () => {
    const output = capabilities();
    const renderer = new HumanTTYRenderer(output, { retryTickMs: 0 });
    const browserUrl = "http://127.0.0.1:4096/L3JlcG8/session/ses_123";

    renderer.handleRuntimeSessionUi({ invocationId: "a", browserUrl });
    expect((output.stdout as RecordingSink).writes).toHaveLength(0);
    renderer.handle(created("a", "Build", 0));

    expect(latest(output.stdout as RecordingSink)).toContain(
      `\u001b]8;;${browserUrl}\u0007Session UI ↗\u001b]8;;\u0007`,
    );
  });

  it("renders the raw session URL without ANSI support", () => {
    const output = capabilities({ supportsAnsi: false });
    const renderer = new HumanTTYRenderer(output, { retryTickMs: 0 });
    const browserUrl = "http://127.0.0.1:4096/L3JlcG8/session/ses_123";

    renderer.handle(created("a", "Build", 0));
    expect(latest(output.stdout as RecordingSink)).not.toContain("Session UI");
    renderer.handleRuntimeSessionUi({ invocationId: "a", browserUrl });

    expect(latest(output.stdout as RecordingSink)).toContain(
      `Session UI: ${browserUrl}`,
    );
  });

  it("renders active phase and activity", () => {
    const output = capabilities();
    const renderer = new HumanTTYRenderer(output, { retryTickMs: 0 });

    renderer.handle(created("a", "Build", 0));
    renderer.handle({
      type: "invocation.started",
      ...run,
      invocationId: "a",
      subject: { type: "task", taskId: "Build" },
      taskId: "Build",
    });
    renderer.handle({
      type: "invocation.progress",
      ...run,
      invocationId: "a",
      state: "active",
      phase: "compile",
      message: "compiling sources",
    });

    expect(latest(output.stdout as RecordingSink)).toContain("Build");
    expect(latest(output.stdout as RecordingSink)).toContain(
      "compile: compiling sources",
    );
  });

  it("keeps the latest tool activity visible after completion", () => {
    const output = capabilities({ supportsAnsi: false });
    const renderer = new HumanTTYRenderer(output, { retryTickMs: 0 });
    renderer.handle(created("a", "Build", 0));
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
      type: "invocation.succeeded",
      ...run,
      invocationId: "a",
    });

    expect(latest(output.stdout as RecordingSink)).toContain(
      "tool filesystem.read succeeded",
    );
    expect(latest(output.stdout as RecordingSink)).toContain(
      "tools: filesystem.read (1)",
    );
  });

  it("prints a distinct tool usage list after completion", async () => {
    const output = capabilities({ supportsAnsi: false });
    const renderer = new HumanTTYRenderer(output, { retryTickMs: 0 });
    renderer.handle(created("a", "Build", 0));
    renderer.handle({
      type: "invocation.activity",
      ...run,
      invocationId: "a",
      activityId: "call-1",
      kind: "tool",
      name: "git",
      state: "succeeded",
    });
    renderer.handle({
      type: "invocation.activity",
      ...run,
      invocationId: "a",
      activityId: "call-2",
      kind: "tool",
      name: "bash",
      state: "succeeded",
    });
    await renderer.finish();

    const outputText = (output.stdout as RecordingSink).writes.join("");
    expect(outputText).toContain("used tools:");
    expect(outputText).toContain("git (1 event)");
    expect(outputText).toContain("bash (1 event)");
  });

  it("renders skill activity and a separate skill summary", async () => {
    const output = capabilities({ supportsAnsi: false });
    const renderer = new HumanTTYRenderer(output, { retryTickMs: 0 });
    renderer.handle(created("a", "Build", 0));
    renderer.handle({
      type: "invocation.activity",
      ...run,
      invocationId: "a",
      activityId: "skill-1",
      kind: "skill",
      name: "web-perf",
      state: "succeeded",
    });
    renderer.handle({
      type: "invocation.succeeded",
      ...run,
      invocationId: "a",
    });
    await renderer.finish();

    const outputText = (output.stdout as RecordingSink).writes.join("");
    expect(outputText).toContain("skill web-perf succeeded");
    expect(outputText).toContain("skills: web-perf (1)");
    expect(outputText).toContain("used skills:");
    expect(outputText).toContain("- web-perf (1 event)");
  });

  it("animates an active task without new execution events", async () => {
    vi.useFakeTimers();
    const output = capabilities({ supportsAnsi: false });
    const renderer = new HumanTTYRenderer(output, {
      retryTickMs: 0,
      spinnerTickMs: 100,
    });

    renderer.handle(created("a", "Build", 0));
    renderer.handle({
      type: "invocation.progress",
      ...run,
      invocationId: "a",
      state: "active",
      phase: "execute",
      message: "working",
    });
    const before = latest(output.stdout as RecordingSink);

    vi.advanceTimersByTime(100);

    const after = latest(output.stdout as RecordingSink);
    expect(after).not.toBe(before);
    expect(after).toMatch(/[⠙⠹⠸⠼⠴⠦⠧⠇⠏|\x2f-\\]/u);
    await renderer.finish();
  });

  it("redraws over the previous frame instead of clearing the screen", () => {
    const output = capabilities();
    const renderer = new HumanTTYRenderer(output, { retryTickMs: 0 });

    renderer.handle(created("a", "Build", 0));
    renderer.handle({
      type: "invocation.progress",
      ...run,
      invocationId: "a",
      state: "active",
      phase: "execute",
      message: "working",
    });

    const secondFrame = (output.stdout as RecordingSink).writes[1] ?? "";
    expect(secondFrame).toContain("\u001b[1F");
    expect(secondFrame).toContain("\u001b[2K");
    expect(secondFrame).not.toContain("\u001b[2J");
  });

  it("keeps the full redraw height after a frame shrinks", () => {
    const output = capabilities();
    const renderer = new HumanTTYRenderer(output, { retryTickMs: 0 });

    renderer.handle(created("a", "Task", 0));
    renderer.handle({
      type: "invocation.progress",
      ...run,
      invocationId: "a",
      state: "active",
      phase: "execute",
      message: "working",
    });
    renderer.handle({
      type: "invocation.succeeded",
      ...run,
      invocationId: "a",
    });
    renderer.handle({
      type: "invocation.output",
      ...run,
      invocationId: "a",
      policy: "persistent",
      channel: "task",
      content: "Task completed",
    });

    const finalFrame = (output.stdout as RecordingSink).writes.at(-1) ?? "";
    expect(finalFrame.startsWith("\u001b[2F")).toBe(true);
  });

  it("renders a run failure reason when no invocation rows exist", () => {
    const output = capabilities();
    const renderer = new HumanTTYRenderer(output, { retryTickMs: 0 });

    renderer.handle({ type: "run.started", ...run });
    renderer.handle({
      type: "run.failed",
      ...run,
      error: {
        category: "RuntimeError",
        message: "Workflow module could not be loaded",
      },
    });

    expect(stripAnsi(latest(output.stdout as RecordingSink))).toContain(
      "run failed: Workflow module could not be loaded",
    );
  });

  it("does not redraw the final frame during finish", async () => {
    const output = capabilities();
    const renderer = new HumanTTYRenderer(output, { retryTickMs: 0 });

    renderer.handle({
      type: "run.failed",
      ...run,
      error: {
        category: "RuntimeError",
        message: "run failed",
      },
    });
    const writesBeforeFinish = (output.stdout as RecordingSink).writes.length;

    await renderer.finish();

    expect((output.stdout as RecordingSink).writes).toHaveLength(
      writesBeforeFinish,
    );
  });

  it("collapses completed nested workflows", () => {
    const output = capabilities();
    const renderer = new HumanTTYRenderer(output, { retryTickMs: 0 });
    renderer.handle(created("workflow", "Workflow", 0, undefined, "workflow"));
    renderer.handle(created("task", "Task", 0, "workflow"));
    renderer.handle({
      type: "invocation.succeeded",
      ...run,
      invocationId: "task",
    });
    renderer.setExpanded("workflow", false);

    const frame = latest(output.stdout as RecordingSink);
    expect(frame).toContain("Workflow");
    expect(frame).not.toContain("Task");
    expect(frame).toContain("1/1 complete");
  });

  it("keeps parallel rows in stable order", () => {
    const output = capabilities();
    const renderer = new HumanTTYRenderer(output, { retryTickMs: 0 });
    renderer.handle(created("a", "A", 0));
    renderer.handle(created("b", "B", 1));
    renderer.handle({
      type: "invocation.progress",
      ...run,
      invocationId: "b",
      state: "active",
      phase: "run",
      message: "B active",
    });
    renderer.handle({
      type: "invocation.progress",
      ...run,
      invocationId: "a",
      state: "active",
      phase: "run",
      message: "A active",
    });

    const frame = stripAnsi(latest(output.stdout as RecordingSink));
    expect(frame.indexOf("A")).toBeLessThan(frame.indexOf("B"));
    expect(frame).toContain("A active");
    expect(frame).toContain("B active");
  });

  it("renders loop hierarchy and body iteration numbers", () => {
    const output = capabilities({ supportsAnsi: false });
    const renderer = new HumanTTYRenderer(output, { retryTickMs: 0 });
    renderer.handle({
      type: "invocation.created",
      ...run,
      invocationId: "loop",
      planNodeId: "repeat:1",
      subject: { type: "task", taskId: "repeat:1" },
      taskId: "repeat:1",
      kind: "loop",
      label: "repeat:1",
      siblingOrder: 0,
      dependencyIds: [],
    });
    renderer.handle({
      type: "invocation.created",
      ...run,
      invocationId: "body-2",
      planNodeId: "repeat:1/body:1",
      subject: { type: "task", taskId: "body" },
      taskId: "body",
      kind: "task",
      label: "body",
      parentInvocationId: "loop",
      siblingOrder: 1,
      dependencyIds: [],
      iteration: 2,
    });

    const frame = latest(output.stdout as RecordingSink);
    expect(frame.indexOf("repeat:1")).toBeLessThan(frame.indexOf("body"));
    expect(frame).toContain("iteration 2");
  });

  it("truncates rows to the current terminal width", () => {
    const output = capabilities({ supportsAnsi: false, width: 18 });
    const renderer = new HumanTTYRenderer(output, { retryTickMs: 0 });
    renderer.handle(created("a", "Very long task label", 0));
    renderer.handle({
      type: "invocation.progress",
      ...run,
      invocationId: "a",
      state: "active",
      phase: "phase",
      message: "a very long activity message",
    });

    for (const line of latest(output.stdout as RecordingSink)
      .trimEnd()
      .split("\n")) {
      expect(line.length).toBeLessThanOrEqual(18);
    }
  });

  it("keeps persistent output after completion", () => {
    const output = capabilities();
    const renderer = new HumanTTYRenderer(output, { retryTickMs: 0 });
    renderer.handle(created("a", "Task", 0));
    renderer.handle({
      type: "invocation.succeeded",
      ...run,
      invocationId: "a",
    });
    renderer.handle({
      type: "invocation.output",
      ...run,
      invocationId: "a",
      policy: "transient",
      channel: "task",
      content: "temporary activity",
    });
    renderer.handle({
      type: "invocation.output",
      ...run,
      invocationId: "a",
      policy: "persistent",
      channel: "task",
      content: "checkpoint",
    });
    renderer.handle({
      type: "invocation.succeeded",
      ...run,
      invocationId: "a",
    });

    const frame = latest(output.stdout as RecordingSink);
    expect(frame).toContain("checkpoint");
    expect(frame).not.toContain("temporary activity");
  });

  it("renders available execution metrics and output shape", () => {
    const output = capabilities({ supportsAnsi: false });
    const renderer = new HumanTTYRenderer(output, { retryTickMs: 0 });
    renderer.handle(created("a", "Task", 0));
    renderer.handle({
      type: "invocation.output",
      ...run,
      invocationId: "a",
      policy: "persistent",
      channel: "task",
      content: "Task completed",
      metrics: {
        durationMs: 1250,
        model: "fake-model",
        provider: "fake-provider",
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

    const frame = latest(output.stdout as RecordingSink);
    expect(frame).toContain("output object");
    expect(frame).toContain("fake-model");
    expect(frame).toContain("42 tokens");
    expect(frame).toContain("$0.0042");
  });

  it("keeps human detail rows compact and aligned", () => {
    const output = capabilities({ supportsAnsi: false });
    const renderer = new HumanTTYRenderer(output, { retryTickMs: 0 });
    renderer.handle(created("a", "Task", 0));
    renderer.handle({
      type: "invocation.succeeded",
      ...run,
      invocationId: "a",
    });
    renderer.handle({
      type: "invocation.output",
      ...run,
      invocationId: "a",
      policy: "persistent",
      channel: "task",
      content: "Task completed",
      metrics: {
        durationMs: 1250,
        model: "fake-model",
        provider: "fake-provider",
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

    const frame = latest(output.stdout as RecordingSink);
    expect(frame).toContain("✓ Task");
    expect(frame).toContain("│ Task completed");
    expect(frame).toContain("│ output object");
    expect(frame).not.toMatch(/[📦🤖🔢💰💬]/u);
  });

  it("renders retry countdowns", () => {
    const output = capabilities();
    const renderer = new HumanTTYRenderer(output, {
      retryTickMs: 0,
      now: () => new Date("2026-08-18T00:00:00.000Z"),
    });
    renderer.handle(created("a", "Retrying task", 0));
    renderer.handle({
      type: "invocation.retrying",
      ...run,
      invocationId: "a",
      attempt: 2,
      maximumAttempts: 3,
      nextAttemptAt: "2026-08-18T00:00:05.500Z",
      lastError: { category: "ExecutorError", message: "failed once" },
    });

    expect(latest(output.stdout as RecordingSink)).toContain(
      "attempt 2/3, retry in 6s",
    );
  });

  it("updates labels without changing row order", () => {
    const output = capabilities();
    const renderer = new HumanTTYRenderer(output, { retryTickMs: 0 });
    renderer.handle(created("a", "Old", 0));
    renderer.handle(created("b", "B", 1));
    renderer.handle({
      type: "invocation.progress",
      ...run,
      invocationId: "a",
      state: "active",
      phase: "run",
      label: "New",
    });

    const frame = stripAnsi(latest(output.stdout as RecordingSink));
    expect(frame.indexOf("New")).toBeLessThan(frame.indexOf("B"));
    expect(frame).not.toContain("Old");
  });

  it("uses safe symbols and no control sequences when unsupported", () => {
    const output = capabilities({
      supportsAnsi: false,
      supportsUnicode: false,
    });
    const renderer = new HumanTTYRenderer(output, { retryTickMs: 0 });
    renderer.handle(created("a", "Task", 0));
    renderer.handle({
      type: "invocation.succeeded",
      ...run,
      invocationId: "a",
    });

    const frame = latest(output.stdout as RecordingSink);
    expect(frame).toContain("[ok]");
    expect(frame).not.toContain("\u001b");
    expect(frame).not.toContain("✓");
  });

  it("routes diagnostics to stderr without corrupting frames", () => {
    const output = capabilities();
    const renderer = new HumanTTYRenderer(output, { retryTickMs: 0 });
    renderer.handle(created("a", "Task", 0));
    renderer.writeDiagnostic("diagnostic");

    expect(latest(output.stderr as RecordingSink)).toBe("diagnostic\n");
    expect(latest(output.stdout as RecordingSink)).not.toContain("diagnostic");
  });

  it("reflows after a terminal resize", () => {
    const output = capabilities({ supportsAnsi: false, width: 80 });
    const renderer = new HumanTTYRenderer(output, { retryTickMs: 0 });
    renderer.handle(created("a", "A very long label", 0));
    renderer.updateTerminal({ width: 10 });

    for (const line of latest(output.stdout as RecordingSink)
      .trimEnd()
      .split("\n")) {
      expect(line.length).toBeLessThanOrEqual(10);
    }
  });

  it("requires a TTY-capable sink", () => {
    expect(
      () =>
        new HumanTTYRenderer(capabilities({ isTTY: false }), {
          retryTickMs: 0,
        }),
    ).toThrow("TTY");
  });

  it("renders validation identity, verdict, issues, and bounded evidence", () => {
    const output = capabilities({ supportsAnsi: false });
    const renderer = new HumanTTYRenderer(output, { retryTickMs: 0 });
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
          issues: [
            { code: "unsafe", message: "Unsafe result", path: "/status" },
          ],
          evidence: {
            state: "truncated",
            summary: { kind: "object", size: 2 },
          },
        },
      },
    });

    const frame = latest(output.stdout as RecordingSink);
    expect(frame).toContain("validation release-ready");
    expect(frame).toContain("verdict failed");
    expect(frame).toContain("unsafe: Unsafe result");
    expect(frame).toContain("evidence truncated");
  });
});
