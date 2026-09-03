import { isPlainRecord } from "@seqlane/core";
import type {
  InvocationActivityEvent,
  SeqlaneExecutionEvent,
} from "@seqlane/events";
import {
  createHumanViewModel,
  reduceHumanViewModel,
  type HumanAggregate,
  type HumanExecutionNode,
  type HumanExecutionViewModel,
} from "./event-reducer.js";
import type {
  ExecutionRenderer,
  OutputCapabilities,
  OutputSink,
} from "./renderer-contract.js";
import {
  formatCIOutputDetails,
  formatCIValidationDetails,
} from "./output-details.js";

export interface CIRendererOptions {
  readonly now?: () => Date;
  readonly heartbeatIntervalMs?: number;
}

export interface CISummary {
  readonly runId?: string;
  readonly outcome: HumanExecutionViewModel["runState"];
  readonly durationMs?: number;
  readonly counts: HumanAggregate;
  readonly runError?: {
    readonly category: string;
    readonly message: string;
  };
  readonly taskDurations: readonly {
    readonly invocationId: string;
    readonly label: string;
    readonly state: HumanExecutionNode["state"];
    readonly durationMs: number;
  }[];
  readonly failures: readonly {
    readonly invocationId: string;
    readonly label: string;
    readonly category: string;
    readonly disposition: string;
    readonly message: string;
  }[];
}

const EMPTY_AGGREGATE: HumanAggregate = {
  total: 0,
  queued: 0,
  waiting: 0,
  active: 0,
  retrying: 0,
  succeeded: 0,
  failed: 0,
  skipped: 0,
  cancelled: 0,
};

const ANSI_ESCAPE_PATTERN = new RegExp(
  String.raw`\u001B(?:\][^\u0007]*(?:\u0007|\u001B\\)|\[[0-?]*[ -/]*[@-~])`,
  "g",
);
const CONTROL_CHARACTER_PATTERN = new RegExp(
  String.raw`[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]`,
  "g",
);

function eventTime(event: SeqlaneExecutionEvent, now: () => Date): string {
  return event.metadata?.occurredAt ?? now().toISOString();
}

function aggregateView(view: HumanExecutionViewModel): HumanAggregate {
  return [...view.nodes.values()].reduce(
    (aggregate, node) => ({
      total: aggregate.total + 1,
      queued: aggregate.queued + (node.state === "queued" ? 1 : 0),
      waiting: aggregate.waiting + (node.state === "waiting" ? 1 : 0),
      active: aggregate.active + (node.state === "active" ? 1 : 0),
      retrying: aggregate.retrying + (node.state === "retrying" ? 1 : 0),
      succeeded: aggregate.succeeded + (node.state === "succeeded" ? 1 : 0),
      failed: aggregate.failed + (node.state === "failed" ? 1 : 0),
      skipped: aggregate.skipped + (node.state === "skipped" ? 1 : 0),
      cancelled: aggregate.cancelled + (node.state === "cancelled" ? 1 : 0),
    }),
    EMPTY_AGGREGATE,
  );
}

function durationBetween(
  startedAt: string | undefined,
  finishedAt: string | undefined,
): number | undefined {
  if (startedAt === undefined || finishedAt === undefined) return undefined;
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return undefined;
  return Math.max(0, finished - started);
}

function sanitizeCI(value: string): string {
  return value
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(CONTROL_CHARACTER_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim();
}

function compactCI(value: string, maximum = 500): string {
  const normalized = sanitizeCI(value);
  return normalized.length <= maximum
    ? normalized
    : normalized.slice(0, Math.max(0, maximum - 1)) + "…";
}

function activityDetail(event: InvocationActivityEvent): string | undefined {
  if (event.kind !== "tool" || event.input?.state !== "present") {
    return undefined;
  }
  const value = event.input.value;
  if (!isPlainRecord(value)) return undefined;
  if (event.name === "bash") {
    const command = value.command;
    return typeof command === "string"
      ? "command=" + compactCI(command, 500)
      : undefined;
  }
  if (event.name === "read") {
    const filePath = value.filePath ?? value.path;
    return typeof filePath === "string"
      ? "path=" + compactCI(filePath, 500)
      : undefined;
  }
  if (event.name === "glob" || event.name === "grep") {
    const pattern = value.pattern;
    const path = value.path;
    const details = [
      typeof pattern === "string" ? "pattern=" + compactCI(pattern, 300) : "",
      typeof path === "string" ? "path=" + compactCI(path, 300) : "",
    ].filter((detail) => detail.length > 0);
    return details.length === 0 ? undefined : details.join(" ");
  }
  return undefined;
}

function formatCIDuration(milliseconds: number): string {
  return milliseconds < 1000
    ? milliseconds + "ms"
    : (milliseconds / 1000).toFixed(1) + "s";
}

function escapeGithubCommandValue(value: string): string {
  return value
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A")
    .replace(/:/g, "%3A")
    .replace(/,/g, "%2C");
}

function annotationLevel(disposition: string): "error" | "warning" {
  return disposition === "retry_scheduled" ||
    disposition === "continue_siblings"
    ? "warning"
    : "error";
}

function isTerminalNode(node: HumanExecutionNode | undefined): boolean {
  return (
    node?.state === "succeeded" ||
    node?.state === "failed" ||
    node?.state === "skipped" ||
    node?.state === "cancelled"
  );
}

export class CIRenderer implements ExecutionRenderer {
  readonly mode = "ci" as const;
  private readonly capabilities: OutputCapabilities;
  private readonly options: CIRendererOptions;
  private readonly now: () => Date;
  private view: HumanExecutionViewModel;
  private runStartedAt: string | undefined;
  private runFinishedAt: string | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private finished = false;
  private _lastError: unknown;
  private _summary: CISummary | undefined;
  private readonly lastProgress = new Map<string, string>();

  constructor(
    capabilities: OutputCapabilities,
    options: CIRendererOptions = {},
  ) {
    this.capabilities = capabilities;
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.view = createHumanViewModel({ now: this.now });
  }

  get lastError(): unknown {
    return this._lastError;
  }

  get summary(): CISummary | undefined {
    return this._summary;
  }

  handle(event: SeqlaneExecutionEvent): void {
    if (this.finished) return;
    const timestamp = eventTime(event, this.now);
    const previousView = this.view;
    this.view = reduceHumanViewModel(this.view, event);
    if (event.type === "run.started") {
      this.runStartedAt = timestamp;
      this.startHeartbeat();
    }
    if (
      event.type === "run.succeeded" ||
      event.type === "run.failed" ||
      event.type === "run.cancelled"
    ) {
      this.runFinishedAt = timestamp;
      this.stopHeartbeat();
    }
    this.writeLine(this.lineFor(event, previousView, this.view));
    this.writeAnnotation(event, this.view);
  }

  handleRunnerFailure(failure: { readonly message: string }): void {
    if (this.finished) return;
    const message = compactCI(failure.message);
    this.stopHeartbeat();
    this.runFinishedAt = this.now().toISOString();
    this.view = {
      ...this.view,
      runState: "failed",
      runError: { category: "RuntimeError", message },
    };
    const runId = this.view.runId ?? "unknown";
    this.writeLine(
      "run=" + runId + " failed category=RuntimeError error=" + message,
    );
    this.writeAnnotationLine(
      "error",
      "Seqlane runner failed",
      "run=" + runId + " category=RuntimeError error=" + message,
    );
  }

  emitHeartbeat(): void {
    if (this.finished || this.view.runState !== "active") return;
    const active = [...this.view.nodes.values()]
      .filter((node) => node.state === "active" || node.state === "retrying")
      .map((node) => node.invocationId);
    const elapsedMs = durationBetween(
      this.runStartedAt,
      this.now().toISOString(),
    );
    this.writeLine(
      "heartbeat run=" +
        (this.view.runId ?? "unknown") +
        " elapsed=" +
        (elapsedMs ?? 0) +
        "ms active=" +
        (active.length === 0 ? "none" : active.join(",")),
    );
  }

  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.stopHeartbeat();
    this._summary = this.createSummary();
    for (const task of this._summary.taskDurations) {
      this.writeLine(this.taskDurationLine(this._summary.runId, task));
    }
    this.writeLine(this.summaryLine(this._summary));
    if (this.capabilities.summary !== undefined) {
      this.safeWrite(
        this.capabilities.summary,
        this.summaryMarkdown(this._summary),
      );
    }
    await this.capabilities.stdout.flush?.();
    await this.capabilities.summary?.flush?.();
  }

  private startHeartbeat(): void {
    const interval = this.options.heartbeatIntervalMs ?? 15_000;
    if (interval <= 0 || this.heartbeatTimer !== undefined) return;
    this.heartbeatTimer = setInterval(() => this.emitHeartbeat(), interval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer === undefined) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private lineFor(
    event: SeqlaneExecutionEvent,
    previousView: HumanExecutionViewModel,
    view: HumanExecutionViewModel,
  ): string {
    switch (event.type) {
      case "run.started":
        return "run=" + event.runId + " started";
      case "run.plan":
        return "";
      case "invocation.created":
        return "";
      case "invocation.progress": {
        const node = view.nodes.get(event.invocationId);
        const previousNode = previousView.nodes.get(event.invocationId);
        const progressKey = [
          event.state,
          event.phase,
          event.waitingReason ?? "",
          event.dependencyIds?.join(",") ?? "",
        ].join("|");
        if (this.lastProgress.get(event.invocationId) === progressKey) {
          return "";
        }
        this.lastProgress.set(event.invocationId, progressKey);
        if (isTerminalNode(previousNode)) return "";
        if (
          previousNode !== undefined &&
          previousNode.state === node?.state &&
          previousNode.phase === node?.phase &&
          previousNode.waitingReason === node?.waitingReason
        ) {
          return "";
        }
        return (
          "run=" +
          event.runId +
          " invocation=" +
          event.invocationId +
          " " +
          event.state +
          " label=" +
          compactCI(node?.label ?? "unknown", 200) +
          " phase=" +
          compactCI(event.phase, 120) +
          (event.waitingReason === undefined
            ? ""
            : " reason=" + compactCI(event.waitingReason, 300))
        );
      }
      case "invocation.activity":
        if (event.state !== "failed") return "";
        {
          const detail = activityDetail(event);
          return (
            "run=" +
            event.runId +
            " invocation=" +
            event.invocationId +
            " activity=" +
            compactCI(event.name, 200) +
            (detail === undefined ? "" : " " + detail) +
            " failed" +
            (event.message === undefined
              ? ""
              : " error=" + compactCI(event.message))
          );
        }
      case "invocation.output":
        if (event.policy !== "persistent") return "";
        {
          const details = formatCIOutputDetails(event.metrics, event.summary);
          return (
            "run=" +
            event.runId +
            " invocation=" +
            event.invocationId +
            " output=" +
            compactCI(event.content) +
            (details === undefined ? "" : " " + details)
          );
        }
      case "invocation.input":
        return "";
      case "invocation.result": {
        const validation = view.nodes.get(event.invocationId)?.validation;
        return validation === undefined
          ? ""
          : "run=" +
              event.runId +
              " invocation=" +
              event.invocationId +
              " " +
              formatCIValidationDetails(validation);
      }
      case "invocation.retrying":
        return (
          "run=" +
          event.runId +
          " invocation=" +
          event.invocationId +
          " retry attempt=" +
          event.attempt +
          (event.maximumAttempts === undefined
            ? ""
            : "/" + event.maximumAttempts) +
          " next=" +
          (event.nextAttemptAt ?? "unknown") +
          " error=" +
          compactCI(event.lastError.message)
        );
      case "invocation.started": {
        const node = view.nodes.get(event.invocationId);
        return (
          "run=" +
          event.runId +
          " invocation=" +
          event.invocationId +
          " started task=" +
          compactCI(event.taskId ?? node?.taskId ?? "unknown", 200) +
          " label=" +
          compactCI(node?.label ?? "unknown", 200) +
          (node?.parentInvocationId === undefined
            ? ""
            : " parent=" + node.parentInvocationId) +
          (event.iteration === undefined ? "" : " iteration=" + event.iteration)
        );
      }
      case "invocation.succeeded": {
        const node = view.nodes.get(event.invocationId);
        return (
          "run=" +
          event.runId +
          " invocation=" +
          event.invocationId +
          " succeeded label=" +
          compactCI(node?.label ?? "unknown", 200) +
          (node?.elapsedMs === undefined
            ? ""
            : " elapsed=" + node.elapsedMs + "ms")
        );
      }
      case "invocation.failed": {
        const node = view.nodes.get(event.invocationId);
        return (
          "run=" +
          event.runId +
          " invocation=" +
          event.invocationId +
          " failed label=" +
          compactCI(node?.label ?? "unknown", 200) +
          " disposition=" +
          event.disposition +
          " category=" +
          event.error.category +
          " error=" +
          compactCI(event.error.message) +
          (event.error.validation === undefined
            ? ""
            : " " +
              formatCIValidationDetails(
                view.nodes.get(event.invocationId)?.validation ?? {
                  validationNodeId: event.error.validation.validationNodeId,
                  sourceId: event.error.validation.sourceId,
                  sourceType: "validation-gate",
                  verdict: "failed",
                  issues: event.error.validation.issues,
                  ...(event.error.validation.evidence === undefined
                    ? {}
                    : { evidence: event.error.validation.evidence }),
                  continued: false,
                },
              ))
        );
      }
      case "invocation.skipped":
        return this.invocationReasonLine(
          event.runId,
          event.invocationId,
          view,
          "skipped",
          event.reason,
        );
      case "invocation.cancelled":
        return this.invocationReasonLine(
          event.runId,
          event.invocationId,
          view,
          "cancelled",
          event.reason,
        );
      case "run.heartbeat":
        return (
          "heartbeat run=" +
          event.runId +
          " elapsed=" +
          event.elapsedMs +
          "ms active=" +
          event.activeInvocationIds.join(",")
        );
      case "run.succeeded":
        return "run=" + event.runId + " succeeded";
      case "run.failed":
        return (
          "run=" +
          event.runId +
          " failed category=" +
          event.error.category +
          " error=" +
          compactCI(event.error.message)
        );
      case "run.cancelled":
        return "run=" + event.runId + " cancelled";
    }
    return "";
  }

  private createSummary(): CISummary {
    return {
      runId: this.view.runId,
      outcome: this.view.runState,
      durationMs: durationBetween(this.runStartedAt, this.runFinishedAt),
      counts: aggregateView(this.view),
      ...(this.view.runError === undefined
        ? {}
        : {
            runError: {
              category: this.view.runError.category,
              message: this.view.runError.message,
            },
          }),
      taskDurations: [...this.view.nodes.values()]
        .filter(
          (node) =>
            node.kind !== "workflow" &&
            node.kind !== "loop" &&
            node.elapsedMs !== undefined,
        )
        .sort((left, right) => left.createdSequence - right.createdSequence)
        .map((node) => ({
          invocationId: node.invocationId,
          label: node.label,
          state: node.state,
          durationMs: node.elapsedMs ?? 0,
        })),
      failures: [...this.view.nodes.values()]
        .filter((node) => node.failure !== undefined)
        .map((node) => ({
          invocationId: node.invocationId,
          label: node.label,
          category: node.failure?.category ?? "RuntimeError",
          disposition: node.failure?.disposition ?? "fail_run",
          message: node.failure?.message ?? "unknown failure",
        })),
    };
  }

  private invocationReasonLine(
    runId: string,
    invocationId: string,
    view: HumanExecutionViewModel,
    state: "skipped" | "cancelled",
    reason: string | undefined,
  ): string {
    const label = view.nodes.get(invocationId)?.label;
    return (
      "run=" +
      runId +
      " invocation=" +
      invocationId +
      " " +
      state +
      (label === undefined ? "" : " label=" + compactCI(label, 200)) +
      (reason === undefined ? "" : " reason=" + compactCI(reason))
    );
  }

  private taskDurationLine(
    runId: string | undefined,
    task: CISummary["taskDurations"][number],
  ): string {
    return (
      "task-duration run=" +
      (runId ?? "unknown") +
      " invocation=" +
      task.invocationId +
      " label=" +
      compactCI(task.label, 200) +
      " state=" +
      task.state +
      " duration=" +
      formatCIDuration(task.durationMs)
    );
  }

  private summaryLine(summary: CISummary): string {
    const counts = summary.counts;
    return (
      "summary run=" +
      (summary.runId ?? "unknown") +
      " outcome=" +
      summary.outcome +
      " total=" +
      counts.total +
      " succeeded=" +
      counts.succeeded +
      " failed=" +
      counts.failed +
      " skipped=" +
      counts.skipped +
      " failures=" +
      summary.failures.length +
      " duration=" +
      (summary.durationMs ?? 0) +
      "ms" +
      (summary.runError === undefined
        ? ""
        : " error=" + compactCI(summary.runError.message))
    );
  }

  private summaryMarkdown(summary: CISummary): string {
    const lines = [
      "## Seqlane execution",
      "",
      "- Run: " + (summary.runId ?? "unknown"),
      "- Outcome: " + summary.outcome,
      "- Total invocations: " + summary.counts.total,
      "- Succeeded: " + summary.counts.succeeded,
      "- Failed: " + summary.counts.failed,
      "- Skipped: " + summary.counts.skipped,
      "- Duration: " + (summary.durationMs ?? 0) + " ms",
    ];
    if (summary.taskDurations.length > 0) {
      lines.push(
        "",
        "### Task durations",
        "",
        "| Task | State | Duration |",
        "| --- | --- | ---: |",
      );
      for (const task of summary.taskDurations) {
        lines.push(
          "| " +
            compactCI(task.label, 200).replaceAll("|", "\\|") +
            " | " +
            task.state +
            " | " +
            formatCIDuration(task.durationMs) +
            " |",
        );
      }
    }
    if (summary.runError !== undefined) {
      lines.push(
        "",
        "### Run error",
        "- " +
          summary.runError.category +
          ": " +
          compactCI(summary.runError.message),
      );
    }
    if (summary.failures.length > 0) {
      lines.push("", "### Failures");
      for (const failure of summary.failures) {
        lines.push(
          "- " +
            failure.invocationId +
            " " +
            compactCI(failure.label, 200) +
            " [" +
            failure.category +
            ", " +
            failure.disposition +
            "]" +
            ": " +
            compactCI(failure.message),
        );
      }
    }
    return lines.join("\n") + "\n";
  }

  private writeLine(line: string): void {
    if (line === "") return;
    const sanitized = sanitizeCI(line);
    if (sanitized === "") return;
    this.safeWrite(this.capabilities.stdout, sanitized + "\n");
  }

  private safeWrite(sink: OutputSink, value: string): void {
    try {
      sink.write(value);
    } catch (error) {
      this._lastError ??= error;
    }
  }

  private writeAnnotation(
    event: SeqlaneExecutionEvent,
    view: HumanExecutionViewModel,
  ): void {
    const sink = this.capabilities.githubActions?.annotations;
    if (sink === undefined) return;

    if (event.type === "invocation.failed") {
      const label = view.nodes.get(event.invocationId)?.label ?? "unknown";
      const level = annotationLevel(event.disposition);
      this.writeAnnotationLine(
        level,
        "Seqlane invocation failed",
        "run=" +
          event.runId +
          " invocation=" +
          event.invocationId +
          " label=" +
          label +
          " category=" +
          event.error.category +
          " disposition=" +
          event.disposition +
          " error=" +
          event.error.message,
      );
      return;
    }

    if (event.type === "run.failed") {
      this.writeAnnotationLine(
        "error",
        "Seqlane run failed",
        "run=" +
          event.runId +
          " category=" +
          event.error.category +
          " error=" +
          event.error.message,
      );
    }
  }

  private writeAnnotationLine(
    level: "error" | "warning",
    title: string,
    message: string,
  ): void {
    const sink = this.capabilities.githubActions?.annotations;
    if (sink === undefined) return;
    this.safeWrite(
      sink,
      "::" +
        level +
        " title=" +
        escapeGithubCommandValue(title) +
        "::" +
        escapeGithubCommandValue(compactCI(message, 1_500)) +
        "\n",
    );
  }
}

export function isCIOutput(value: string): boolean {
  return !value.includes("\u001b") && !value.includes("\r");
}
