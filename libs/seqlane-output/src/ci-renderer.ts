import type { SeqlaneExecutionEvent } from "@seqlane/events";
import {
  createHumanViewModel,
  reduceHumanViewModel,
  type HumanAggregate,
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
  readonly failures: readonly {
    readonly invocationId: string;
    readonly label: string;
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
    this.writeLine(this.lineFor(event, this.view));
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
    view: HumanExecutionViewModel,
  ): string {
    switch (event.type) {
      case "run.started":
        return "run=" + event.runId + " started";
      case "run.plan":
        return "";
      case "invocation.created":
        return (
          "run=" +
          event.runId +
          " invocation=" +
          event.invocationId +
          " created label=" +
          event.label +
          " kind=" +
          event.kind +
          (event.parentInvocationId === undefined
            ? ""
            : " parent=" + event.parentInvocationId) +
          (event.iteration === undefined ? "" : " iteration=" + event.iteration)
        );
      case "invocation.progress":
        return (
          "run=" +
          event.runId +
          " invocation=" +
          event.invocationId +
          " " +
          event.state +
          " phase=" +
          event.phase +
          (event.waitingReason === undefined
            ? ""
            : " reason=" + event.waitingReason)
        );
      case "invocation.activity":
        return (
          "run=" +
          event.runId +
          " invocation=" +
          event.invocationId +
          " " +
          (event.kind === "skill" ? "skill=" : "tool=") +
          event.name +
          " state=" +
          event.state
        );
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
            event.content +
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
          event.lastError.message
        );
      case "invocation.started":
        return (
          "run=" +
          event.runId +
          " invocation=" +
          event.invocationId +
          " started task=" +
          event.taskId +
          (event.iteration === undefined ? "" : " iteration=" + event.iteration)
        );
      case "invocation.succeeded":
        return (
          "run=" +
          event.runId +
          " invocation=" +
          event.invocationId +
          " succeeded"
        );
      case "invocation.failed":
        return (
          "run=" +
          event.runId +
          " invocation=" +
          event.invocationId +
          " failed disposition=" +
          event.disposition +
          " error=" +
          event.error.message +
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
      case "invocation.skipped":
        return (
          "run=" +
          event.runId +
          " invocation=" +
          event.invocationId +
          " skipped reason=" +
          event.reason
        );
      case "invocation.cancelled":
        return (
          "run=" +
          event.runId +
          " invocation=" +
          event.invocationId +
          " cancelled" +
          (event.reason === undefined ? "" : " reason=" + event.reason)
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
        return "run=" + event.runId + " failed error=" + event.error.message;
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
      failures: [...this.view.nodes.values()]
        .filter((node) => node.failure !== undefined)
        .map((node) => ({
          invocationId: node.invocationId,
          label: node.label,
          message: node.failure?.message ?? "unknown failure",
        })),
    };
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
      " duration=" +
      (summary.durationMs ?? 0) +
      "ms"
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
    if (summary.failures.length > 0) {
      lines.push("", "### Failures");
      for (const failure of summary.failures) {
        lines.push(
          "- " +
            failure.invocationId +
            " " +
            failure.label +
            ": " +
            failure.message,
        );
      }
    }
    return lines.join("\n") + "\n";
  }

  private writeLine(line: string): void {
    if (line === "") return;
    this.safeWrite(this.capabilities.stdout, line + "\n");
  }

  private safeWrite(sink: OutputSink, value: string): void {
    try {
      sink.write(value);
    } catch (error) {
      this._lastError ??= error;
    }
  }
}

export function isCIOutput(value: string): boolean {
  return !value.includes("\u001b") && !value.includes("\r");
}
