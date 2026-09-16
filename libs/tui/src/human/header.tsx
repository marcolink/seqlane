import { Box, Text } from "ink";
import { useMemo } from "react";
import { workTone } from "./theme.js";
import { encodeTerminalField } from "../terminal-field.js";
import type { RunViewModel } from "../run-view-model.js";
import {
  formatDuration,
  statusColor,
  statusSymbol,
  type HumanDisplayCapabilities,
} from "./format.js";

export interface HumanHeaderProps {
  readonly view: RunViewModel;
  readonly elapsedMs?: number;
  readonly capabilities: HumanDisplayCapabilities;
  readonly spinnerFrame: number;
}
export function HumanHeader({
  view,
  elapsedMs,
  capabilities,
  spinnerFrame,
}: HumanHeaderProps): React.JSX.Element {
  const counts = useMemo(() => {
    const tasks = [...view.nodes.values()].filter(
      (node) => node.kind === "task",
    );
    return {
      total: view.plannedTaskCount ?? tasks.length,
      complete: tasks.filter((node) => node.state === "succeeded").length,
      incompleteProjection:
        view.plannedTaskCount !== undefined &&
        view.plannedTaskCount > tasks.length,
    };
  }, [view.nodes, view.plannedTaskCount]);
  const state = view.runState === "idle" ? "queued" : view.runState;
  const lowerBound = capabilities.supportsUnicode ? "≥" : ">=";
  const facts =
    (counts.incompleteProjection ? lowerBound : "") +
    counts.complete +
    "/" +
    counts.total +
    " · " +
    formatDuration(elapsedMs);
  const width = Math.max(1, capabilities.width ?? 80);
  const disclosure = capabilities.supportsUnicode ? " ▼ " : " v ";
  const color = capabilities.supportsAnsi ? statusColor(state) : undefined;
  const tone = workTone("workflow", state, capabilities.supportsAnsi);
  return (
    <Box width={width}>
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        <Text wrap="truncate-end">
          <Text color={color} bold={tone.bold}>
            {statusSymbol(state, capabilities.supportsUnicode, spinnerFrame)}
          </Text>
          <Text {...tone}>
            {disclosure +
              encodeTerminalField(
                view.workflowLabel ?? "Seqlane run",
                capabilities.redactions,
              )}
          </Text>
        </Text>
      </Box>
      <Box paddingLeft={1} flexShrink={0} maxWidth={Math.max(1, width - 8)}>
        <Text {...tone} wrap="truncate-end">
          {facts}
        </Text>
      </Box>
    </Box>
  );
}
