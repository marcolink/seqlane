import { Box, Text } from "ink";
import type { RunViewModel } from "../run-view-model.js";
import { formatDuration } from "./format.js";

export interface HumanDetailsProps {
  readonly view: RunViewModel;
}

export function HumanDetails({
  view,
}: HumanDetailsProps): React.JSX.Element | null {
  const focused = [...view.presentation.entries()].find(
    ([, state]) => state.isFocused,
  )?.[0];
  const node = focused === undefined ? undefined : view.nodes.get(focused);
  if (node === undefined) return null;
  const detail =
    node.failure?.message ??
    node.waitingReason ??
    node.activity ??
    node.output.persistent.at(-1);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>────────────────</Text>
      <Text bold>{node.label}</Text>
      <Text>
        {node.state +
          (node.elapsedMs === undefined
            ? ""
            : ` · ${formatDuration(node.elapsedMs)}`)}
      </Text>
      {detail === undefined ? null : (
        <Text color={node.failure === undefined ? undefined : "red"}>
          {detail}
        </Text>
      )}
    </Box>
  );
}
