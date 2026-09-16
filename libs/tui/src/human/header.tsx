import { Box, Text, useAnimation } from "ink";
import { useMemo } from "react";
import { workTone } from "./theme.js";
import { encodeTerminalField } from "../terminal-field.js";
import type { RunViewModel } from "../run-view-model.js";
import { getRootRunElapsedMs } from "../run-view-model.js";
import {
  formatDuration,
  statusColor,
  statusSymbol,
  type HumanDisplayCapabilities,
} from "./format.js";

export interface HumanHeaderProps {
  readonly view: RunViewModel;
  readonly capabilities: HumanDisplayCapabilities;
  readonly spinnerFrame: number;
  readonly animate?: boolean;
}
export function HumanHeader({
  view,
  capabilities,
  spinnerFrame,
  animate = false,
}: HumanHeaderProps): React.JSX.Element {
  const animation = useAnimation({
    interval: 100,
    isActive: animate && view.runState === "active",
  });
  const frame = animate ? animation.frame : spinnerFrame;
  const counts = useMemo(() => {
    const tasks = [...view.nodes.values()].filter(
      (node) => node.kind === "task",
    );
    const total = (view.plannedTaskCount ?? 0) + view.dynamicTaskCount;
    return {
      total,
      complete: tasks.filter((node) => node.state === "succeeded").length,
      incompleteProjection: total > tasks.length,
    };
  }, [view.dynamicTaskCount, view.nodes, view.plannedTaskCount]);
  const state = view.runState === "idle" ? "queued" : view.runState;
  const lowerBound = capabilities.supportsUnicode ? "≥" : ">=";
  const facts =
    (counts.incompleteProjection ? lowerBound : "") +
    counts.complete +
    "/" +
    counts.total +
    " · " +
    formatDuration(getRootRunElapsedMs(view));
  const width = Math.max(1, capabilities.width ?? 80);
  const disclosure = capabilities.supportsUnicode ? " ▼ " : " v ";
  const color = capabilities.supportsAnsi ? statusColor(state) : undefined;
  const tone = workTone("workflow", state, capabilities.supportsAnsi);
  return (
    <Box width={width}>
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        <Text wrap="truncate-end">
          <Text color={color} bold={tone.bold}>
            {statusSymbol(state, capabilities.supportsUnicode, frame)}
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
