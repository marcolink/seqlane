import type { RunNodeState, RunVisibleRow } from "../run-view-model.js";

export interface HumanDisplayCapabilities {
  readonly supportsAnsi: boolean;
  readonly supportsUnicode: boolean;
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
): string {
  const disclosure =
    row.hasChildren &&
    (row.node.kind === "workflow" || row.node.kind === "loop")
      ? row.isExpanded
        ? capabilities.supportsUnicode
          ? "▼"
          : "v"
        : capabilities.supportsUnicode
          ? "▶"
          : ">"
      : " ";
  return "  ".repeat(row.depth) + disclosure;
}

export function formatDuration(milliseconds: number | undefined): string {
  if (milliseconds === undefined) return "";
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}s`;
  return `${Math.floor(milliseconds / 60_000)}m ${Math.floor(
    (milliseconds % 60_000) / 1_000,
  )}s`;
}
