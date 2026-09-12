import type { SeqlaneExecutionEvent } from "@seqlane/core";
import {
  createHumanViewModel,
  getHumanVisibleRows,
  reduceHumanViewModel,
  setHumanNodeExpanded,
  type HumanExecutionViewModel,
  type HumanNodeState,
  type HumanVisibleRow,
} from "./event-reducer.js";
import type {
  ExecutionRenderer,
  OutputCapabilities,
  RuntimeSessionUi,
} from "./renderer-contract.js";
import {
  formatHumanOutputDetails,
  formatHumanValidationDetails,
} from "./output-details.js";

export interface HumanTTYRendererOptions {
  readonly now?: () => Date;
  readonly retryTickMs?: number;
  readonly spinnerTickMs?: number;
}

export interface HumanTerminalUpdate {
  readonly width?: number;
  readonly supportsAnsi?: boolean;
  readonly supportsUnicode?: boolean;
}

const ANSI_CLEAR_LINE = "\u001b[2K\r";
const UNICODE_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ASCII_SPINNER = ["|", "/", "-", "\\"];

function clearStaleLines(lineCount: number): string {
  return Array.from({ length: lineCount }, () => ANSI_CLEAR_LINE + "\n").join(
    "",
  );
}

function statusSymbol(
  state: HumanNodeState,
  supportsUnicode: boolean,
  spinnerFrame: number,
): string {
  if (!supportsUnicode) {
    switch (state) {
      case "succeeded":
        return "[ok]";
      case "failed":
        return "[!!]";
      case "active":
        return "[" + ASCII_SPINNER[spinnerFrame % ASCII_SPINNER.length] + " ]";
      case "waiting":
        return "[..]";
      case "retrying":
        return "[R ]";
      case "skipped":
        return "[--]";
      case "cancelled":
        return "[! ]";
      case "queued":
        return "[  ]";
    }
  }

  switch (state) {
    case "succeeded":
      return "✓";
    case "failed":
      return "✗";
    case "active":
      return UNICODE_SPINNER[spinnerFrame % UNICODE_SPINNER.length] ?? "⠋";
    case "waiting":
      return "◌";
    case "retrying":
      return "↻";
    case "skipped":
      return "↷";
    case "cancelled":
      return "!";
    case "queued":
      return "○";
  }
}

function statusColor(state: HumanNodeState): string {
  if (state === "succeeded") return "\u001b[32m";
  if (state === "failed" || state === "cancelled") return "\u001b[31m";
  if (state === "active") return "\u001b[36m";
  if (state === "waiting" || state === "retrying") return "\u001b[33m";
  return "\u001b[90m";
}

function detailText(value: string, supportsAnsi: boolean): string {
  return supportsAnsi ? "\u001b[90m" + value + "\u001b[39m" : value;
}

function truncate(value: string, width: number): string {
  if (width <= 0) return "";
  if (value.length <= width) return value;
  if (width === 1) return "…";
  return value.slice(0, width - 1) + "…";
}

function formatDuration(milliseconds: number | undefined): string {
  if (milliseconds === undefined) return "";
  if (milliseconds < 1000) return milliseconds + "ms";
  return (milliseconds / 1000).toFixed(1) + "s";
}

function retryCountdown(
  nextAttemptAt: string | undefined,
  now: Date,
): string | undefined {
  if (nextAttemptAt === undefined) return undefined;
  const remaining = Math.max(0, Date.parse(nextAttemptAt) - now.getTime());
  return "retry in " + Math.ceil(remaining / 1000) + "s";
}

function formatActivityUsage(
  usage: ReadonlyMap<string, number>,
): string | undefined {
  if (usage.size === 0) return undefined;
  return [...usage.entries()]
    .map(([name, count]) => `${name} (${count})`)
    .join(", ");
}

function formatSessionUi(
  browserUrl: string,
  supportsAnsi: boolean,
  supportsUnicode: boolean,
  width: number,
): string {
  if (!supportsAnsi) return "Session UI: " + browserUrl;
  const label = supportsUnicode ? "Session UI ↗" : "Session UI ->";
  const visibleLabel = truncate(label, width);
  return `\u001b]8;;${browserUrl}\u0007${visibleLabel}\u001b]8;;\u0007`;
}

function renderRow(
  row: HumanVisibleRow,
  width: number,
  supportsUnicode: boolean,
  supportsAnsi: boolean,
  now: Date,
  spinnerFrame: number,
  sessionUiByInvocation: ReadonlyMap<string, string>,
): string[] {
  const { node, depth, hasChildren } = row;
  const indentation = "  ".repeat(depth);
  const disclosure =
    hasChildren && (node.kind === "workflow" || node.kind === "loop")
      ? node.presentation.isExpanded
        ? "▼ "
        : "▶ "
      : "";
  const aggregate =
    (node.kind === "workflow" || node.kind === "loop") &&
    node.aggregate.total > 0
      ? " (" +
        node.aggregate.succeeded +
        "/" +
        node.aggregate.total +
        " complete)"
      : "";
  const duration = formatDuration(node.elapsedMs);
  const main = [
    indentation + statusSymbol(node.state, supportsUnicode, spinnerFrame),
    disclosure +
      node.label +
      (node.iteration === undefined
        ? ""
        : " (iteration " + node.iteration + ")") +
      aggregate,
    duration,
  ]
    .filter(Boolean)
    .join(" ");
  const mainLine = truncate(main, width);
  const status = statusSymbol(node.state, supportsUnicode, spinnerFrame);
  const statusStart = indentation.length;
  const lines = [
    supportsAnsi
      ? mainLine.slice(0, statusStart) +
        statusColor(node.state) +
        status +
        "\u001b[39m" +
        mainLine.slice(statusStart + status.length)
      : mainLine,
  ];
  const detailIndent = "  ".repeat(depth + 1);
  const browserUrl = sessionUiByInvocation.get(node.invocationId);
  if (browserUrl !== undefined) {
    const sessionUi = formatSessionUi(
      browserUrl,
      supportsAnsi,
      supportsUnicode,
      Math.max(0, width - detailIndent.length),
    );
    lines.push(
      supportsAnsi
        ? detailIndent + sessionUi
        : truncate(detailIndent + sessionUi, width),
    );
  }

  if (node.state === "waiting" && node.waitingReason !== undefined) {
    const dependencies =
      node.waitingDependencyLabels.length === 0
        ? ""
        : " (" + node.waitingDependencyLabels.join(", ") + ")";
    lines.push(
      detailText(
        truncate(detailIndent + node.waitingReason + dependencies, width),
        supportsAnsi,
      ),
    );
  } else if (node.state === "retrying" && node.retry !== undefined) {
    const countdown = retryCountdown(node.retry.nextAttemptAt, now);
    const retryText =
      "attempt " +
      node.retry.attempt +
      (node.retry.maximumAttempts === undefined
        ? ""
        : "/" + node.retry.maximumAttempts) +
      (countdown === undefined ? "" : ", " + countdown);
    lines.push(
      detailText(truncate(detailIndent + retryText, width), supportsAnsi),
    );
  } else if (
    node.activity !== undefined &&
    (node.state === "active" || node.state === "succeeded")
  ) {
    const phase = node.phase === undefined ? "" : node.phase + ": ";
    lines.push(
      detailText(
        truncate(detailIndent + phase + node.activity, width),
        supportsAnsi,
      ),
    );
  } else if (node.failure !== undefined) {
    lines.push(
      detailText(
        truncate(detailIndent + node.failure.message, width),
        supportsAnsi,
      ),
    );
  } else if (node.skipReason !== undefined) {
    lines.push(
      detailText(truncate(detailIndent + node.skipReason, width), supportsAnsi),
    );
  }

  const completed =
    node.state === "succeeded" ||
    node.state === "failed" ||
    node.state === "cancelled";
  const toolUsage = completed ? formatActivityUsage(node.toolUsage) : undefined;
  if (toolUsage !== undefined) {
    lines.push(
      detailText(
        truncate(detailIndent + "tools: " + toolUsage, width),
        supportsAnsi,
      ),
    );
  }
  const skillUsage = completed
    ? formatActivityUsage(node.skillUsage)
    : undefined;
  if (skillUsage !== undefined) {
    lines.push(
      detailText(
        truncate(detailIndent + "skills: " + skillUsage, width),
        supportsAnsi,
      ),
    );
  }

  if (node.validation !== undefined) {
    for (const validationDetail of formatHumanValidationDetails(
      node.validation,
    )) {
      lines.push(
        detailText(
          truncate(detailIndent + validationDetail, width),
          supportsAnsi,
        ),
      );
    }
  }

  for (const output of node.output.persistent) {
    lines.push(
      detailText(truncate(detailIndent + "│ " + output, width), supportsAnsi),
    );
  }
  const outputDetails = formatHumanOutputDetails(
    node.output.metrics,
    node.output.summary,
  );
  for (const outputDetail of outputDetails) {
    lines.push(
      detailText(
        truncate(detailIndent + "│ " + outputDetail, width),
        supportsAnsi,
      ),
    );
  }
  return lines;
}

function humanFrameLines(
  view: HumanExecutionViewModel,
  capabilities: Pick<
    OutputCapabilities,
    "supportsAnsi" | "supportsUnicode" | "width"
  >,
  now: Date,
  spinnerFrame: number,
  sessionUiByInvocation: ReadonlyMap<string, string>,
): string[] {
  const lines = getHumanVisibleRows(view).flatMap((row) =>
    renderRow(
      row,
      Math.max(1, capabilities.width),
      capabilities.supportsUnicode,
      capabilities.supportsAnsi,
      now,
      spinnerFrame,
      sessionUiByInvocation,
    ),
  );
  if (view.runError !== undefined) {
    lines.push(
      truncate(
        "run failed: " + view.runError.message,
        Math.max(1, capabilities.width),
      ),
    );
  }
  if (lines.length === 0) {
    lines.push(
      view.runState === "idle" ? "waiting for execution" : view.runState,
    );
  }
  return lines;
}

export function renderHumanFrame(
  view: HumanExecutionViewModel,
  capabilities: Pick<
    OutputCapabilities,
    "supportsAnsi" | "supportsUnicode" | "width"
  >,
  now: Date = view.now(),
  previousLineCount = 0,
  spinnerFrame = 0,
  sessionUiByInvocation: ReadonlyMap<string, string> = new Map(),
): string {
  const lines = humanFrameLines(
    view,
    capabilities,
    now,
    spinnerFrame,
    sessionUiByInvocation,
  );
  const frame = lines.join("\n") + "\n";
  if (!capabilities.supportsAnsi) return frame;

  const moveToPreviousFrame =
    previousLineCount === 0 ? "" : `\u001b[${previousLineCount}F`;
  const clearAndWrite = lines
    .map((line) => ANSI_CLEAR_LINE + line + "\n")
    .join("");
  const staleLineCount = Math.max(0, previousLineCount - lines.length);
  return moveToPreviousFrame + clearAndWrite + clearStaleLines(staleLineCount);
}

export class HumanTTYRenderer implements ExecutionRenderer {
  readonly mode = "human" as const;
  private capabilities: OutputCapabilities;
  private readonly options: HumanTTYRendererOptions;
  private view: HumanExecutionViewModel;
  private retryTimer: ReturnType<typeof setInterval> | undefined;
  private previousFrameLineCount = 0;
  private spinnerFrame = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | undefined;
  private readonly sessionUiByInvocation = new Map<string, string>();
  private finished = false;

  constructor(
    capabilities: OutputCapabilities,
    options: HumanTTYRendererOptions = {},
  ) {
    if (!capabilities.isTTY) {
      throw new Error("Human output requires a TTY-capable sink");
    }
    this.capabilities = capabilities;
    this.options = options;
    this.view = createHumanViewModel({ now: options.now });
    if ((options.retryTickMs ?? 1000) > 0) {
      this.retryTimer = setInterval(() => {
        if (!this.finished) this.render();
      }, options.retryTickMs ?? 1000);
    }
    if ((options.spinnerTickMs ?? 120) > 0) {
      this.spinnerTimer = setInterval(() => {
        if (this.finished || !this.hasActiveTask()) return;
        this.spinnerFrame += 1;
        this.render();
      }, options.spinnerTickMs ?? 120);
    }
  }

  get currentView(): HumanExecutionViewModel {
    return this.view;
  }

  handle(event: SeqlaneExecutionEvent): void {
    if (this.finished) return;
    this.view = reduceHumanViewModel(this.view, event);
    if (event.type === "invocation.output" && event.channel === "run") {
      this.writeDiagnostic("[" + event.invocationId + "] " + event.content);
    }
    this.render();
  }

  handleRuntimeSessionUi(notification: RuntimeSessionUi): void {
    if (this.finished) return;
    this.sessionUiByInvocation.set(
      notification.invocationId,
      notification.browserUrl,
    );
    if (this.view.nodes.has(notification.invocationId)) this.render();
  }

  setExpanded(invocationId: string, isExpanded: boolean): void {
    this.view = setHumanNodeExpanded(this.view, invocationId, isExpanded);
    this.render();
  }

  updateTerminal(update: HumanTerminalUpdate): void {
    this.capabilities = {
      ...this.capabilities,
      ...(update.width === undefined ? {} : { width: update.width }),
      ...(update.supportsAnsi === undefined
        ? {}
        : { supportsAnsi: update.supportsAnsi }),
      ...(update.supportsUnicode === undefined
        ? {}
        : { supportsUnicode: update.supportsUnicode }),
    };
    this.render();
  }

  writeDiagnostic(value: string): void {
    this.capabilities.stderr.write(value.endsWith("\n") ? value : value + "\n");
  }

  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    if (this.retryTimer !== undefined) clearInterval(this.retryTimer);
    if (this.spinnerTimer !== undefined) clearInterval(this.spinnerTimer);
    this.writeToolUsage();
    await this.capabilities.stdout.flush?.();
    await this.capabilities.stderr.flush?.();
  }

  private writeToolUsage(): void {
    const lines: string[] = [];
    if (this.view.toolUsage.size > 0) {
      lines.push("used tools:");
      for (const [name, count] of this.view.toolUsage) {
        lines.push(`- ${name} (${count} ${count === 1 ? "event" : "events"})`);
      }
    }
    if (this.view.skillUsage.size > 0) {
      lines.push("used skills:");
      for (const [name, count] of this.view.skillUsage) {
        lines.push(`- ${name} (${count} ${count === 1 ? "event" : "events"})`);
      }
    }
    if (lines.length === 0) return;
    this.capabilities.stdout.write(lines.join("\n") + "\n");
  }

  private render(): void {
    const now = (this.options.now ?? this.view.now)();
    const frame = renderHumanFrame(
      this.view,
      this.capabilities,
      now,
      this.previousFrameLineCount,
      this.spinnerFrame,
      this.sessionUiByInvocation,
    );
    const renderedLineCount = humanFrameLines(
      this.view,
      this.capabilities,
      now,
      this.spinnerFrame,
      this.sessionUiByInvocation,
    ).length;
    // Stale-line clearing leaves the cursor below the old frame height.
    this.previousFrameLineCount = Math.max(
      this.previousFrameLineCount,
      renderedLineCount,
    );
    this.capabilities.stdout.write(frame);
  }

  private hasActiveTask(): boolean {
    return [...this.view.nodes.values()].some(
      (node) => node.state === "active",
    );
  }
}
