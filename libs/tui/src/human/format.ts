import type { RunNodeState, RunVisibleRow } from "../run-view-model.js";
import { usageSummary } from "./usage.js";

export interface HumanDisplayCapabilities {
  readonly redactions?: readonly string[];
  readonly supportsAnsi: boolean;
  readonly supportsUnicode: boolean;
  readonly width?: number;
  readonly height?: number;
}

const UNICODE_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ASCII_SPINNER = ["|", "/", "-", "\\"];

export function statusSymbol(
  state: RunNodeState,
  supportsUnicode: boolean,
  spinnerFrame: number,
): string {
  if (!supportsUnicode) {
    switch (state) {
      case "active":
        return ASCII_SPINNER[spinnerFrame % ASCII_SPINNER.length] ?? "*";
      case "succeeded":
        return "+";
      case "retrying":
        return "~";
      case "waiting":
        return ":";
      case "queued":
        return ".";
      case "failed":
        return "x";
      case "cancelled":
        return "!";
      case "skipped":
        return "-";
    }
  }
  switch (state) {
    case "active":
      return UNICODE_SPINNER[spinnerFrame % UNICODE_SPINNER.length] ?? "⠋";
    case "succeeded":
      return "✓";
    case "retrying":
      return "↻";
    case "waiting":
      return "◌";
    case "queued":
      return "○";
    case "failed":
      return "✗";
    case "cancelled":
      return "■";
    case "skipped":
      return "–";
  }
}

export function statusColor(state: RunNodeState): string | undefined {
  switch (state) {
    case "active":
      return "cyan";
    case "succeeded":
      return "green";
    case "retrying":
    case "waiting":
    case "cancelled":
      return "yellow";
    case "failed":
      return "red";
    case "queued":
    case "skipped":
      return "gray";
  }
}

export function treePrefix(
  row: RunVisibleRow,
  capabilities: HumanDisplayCapabilities,
  lastSibling: boolean,
): string {
  const limit = Math.min(
    32,
    Math.max(0, Math.floor(((capabilities.width ?? 80) - 24) / 3)),
  );
  const omitted = Math.max(0, row.ancestorRails.length - limit);
  const rail = capabilities.supportsUnicode ? "│  " : "|  ";
  const branches = capabilities.supportsUnicode
    ? ["├─ ", "└─ "]
    : ["+- ", "\\\\- "];
  return (
    (omitted ? "+" + omitted + " " : "") +
    row.ancestorRails
      .slice(omitted)
      .map((continues) => (continues ? rail : "   "))
      .join("") +
    branches[lastSibling ? 1 : 0]
  );
}

export function disclosureSymbol(row: RunVisibleRow, unicode: boolean): string {
  if (!row.hasChildren) return "";
  if (row.isExpanded) return unicode ? "▼ " : "v ";
  return unicode ? "▶ " : "> ";
}

export function nodeFacts(row: RunVisibleRow, now: Date): string {
  const { node } = row;
  if (node.state === "waiting" || node.state === "queued") return node.state;
  const elapsed =
    node.elapsedMs ??
    (node.startedAt === undefined
      ? undefined
      : Math.max(0, now.getTime() - Date.parse(node.startedAt)));
  const duration = formatDuration(elapsed);
  if (node.retry !== undefined && node.state === "retrying") {
    const maximum =
      node.retry.maximumAttempts === undefined
        ? ""
        : "/" + node.retry.maximumAttempts;
    const remaining =
      node.retry.nextAttemptAt === undefined
        ? duration
        : Math.max(
            0,
            Math.ceil(
              (Date.parse(node.retry.nextAttemptAt) - now.getTime()) / 1000,
            ),
          ) + "s";
    return (
      "attempt " +
      node.retry.attempt +
      maximum +
      (remaining ? " · " + remaining : "")
    );
  }
  if (row.hasChildren)
    return (
      node.aggregate.succeeded + "/" + node.aggregate.total + " · " + duration
    );
  const usage = node.state === "succeeded" ? usageSummary(node, true) : "";
  return [usage, duration].filter(Boolean).join(" · ");
}

export function formatDuration(milliseconds: number | undefined): string {
  if (milliseconds === undefined) return "";
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}s`;
  return (
    String(Math.floor(milliseconds / 60_000)).padStart(2, "0") +
    ":" +
    String(Math.floor((milliseconds % 60_000) / 1_000)).padStart(2, "0")
  );
}
