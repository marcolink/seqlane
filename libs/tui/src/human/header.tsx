import { Box, Text } from "ink";
import type { RunViewModel } from "../run-view-model.js";
import { formatDuration } from "./format.js";

export interface HumanHeaderProps {
  readonly view: RunViewModel;
  readonly elapsedMs?: number;
}

export function HumanHeader({
  view,
  elapsedMs,
}: HumanHeaderProps): React.JSX.Element {
  const root = view.rootInvocationIds[0];
  const label =
    root === undefined
      ? "Seqlane run"
      : (view.nodes.get(root)?.label ?? "Seqlane run");
  const aggregate =
    root === undefined ? undefined : view.nodes.get(root)?.aggregate;
  return (
    <Box flexDirection="column">
      <Text bold>
        {label + " " + view.runState + " · total " + formatDuration(elapsedMs)}
      </Text>
      <Text dimColor>
        {(view.workId === undefined ? "" : `work=${view.workId} `) +
          (view.runId === undefined ? "" : `run=${view.runId} `) +
          (aggregate === undefined
            ? ""
            : `${aggregate.succeeded}/${aggregate.total} complete`)}
      </Text>
    </Box>
  );
}
