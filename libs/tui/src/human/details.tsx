import { Box, Text } from "ink";
import type { RunViewModel } from "../run-view-model.js";
import { formatDuration } from "./format.js";

export interface HumanDetailsProps {
  readonly view: RunViewModel;
  readonly maxLines?: number;
}

export function HumanDetails({
  view,
  maxLines = 5,
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
  const breadcrumb =
    node.parentInvocationId === undefined
      ? "root"
      : `parent: ${node.parentInvocationId}`;
  const lines = [
    <Text key="label" bold>
      {node.label}
    </Text>,
    <Text key="breadcrumb" dimColor>
      {breadcrumb}
    </Text>,
    <Text key="state">
      {node.state +
        (node.elapsedMs === undefined
          ? ""
          : ` · ${formatDuration(node.elapsedMs)}`)}
    </Text>,
    ...(detail === undefined
      ? []
      : [
          <Text
            key="detail"
            color={node.failure === undefined ? undefined : "red"}
          >
            {detail}
          </Text>,
        ]),
  ].slice(0, maxLines);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>────────────────</Text>
      {lines}
    </Box>
  );
}
