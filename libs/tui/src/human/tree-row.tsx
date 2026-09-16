import { Box, Text } from "ink";
import { workTone } from "./theme.js";
import type { RunVisibleRow } from "../run-view-model.js";
import {
  statusColor,
  statusSymbol,
  treePrefix,
  disclosureSymbol,
  nodeFacts,
  type HumanDisplayCapabilities,
} from "./format.js";

export interface HumanTreeRowProps {
  readonly row: RunVisibleRow;
  readonly capabilities: HumanDisplayCapabilities;
  readonly spinnerFrame: number;
  readonly lastSibling: boolean;
  readonly now: Date;
}
export function HumanTreeRow({
  row,
  capabilities,
  spinnerFrame,
  lastSibling,
  now,
}: HumanTreeRowProps): React.JSX.Element {
  const { node } = row;
  const width = Math.max(1, capabilities.width ?? 80);
  const unicode = capabilities.supportsUnicode;
  const facts = nodeFacts(row, now);
  const prefix = treePrefix(row, capabilities, lastSibling);
  const tone = workTone(node.kind, node.state, capabilities.supportsAnsi);
  const color = capabilities.supportsAnsi ? statusColor(node.state) : undefined;
  return (
    <Box flexDirection="column">
      <Box width={width}>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text wrap="truncate-end">
            <Text {...tone}>{prefix}</Text>
            <Text color={color} bold={tone.bold}>
              {statusSymbol(node.state, unicode, spinnerFrame)}
            </Text>
            <Text {...tone}>
              {" " + disclosureSymbol(row, unicode) + node.label}
            </Text>
          </Text>
        </Box>
        <Box paddingLeft={1} flexShrink={0} maxWidth={Math.max(1, width - 12)}>
          <Text {...tone} wrap="truncate-end">
            {facts}
          </Text>
        </Box>
      </Box>
      {node.failure === undefined ? null : (
        <Text color={color}>{"   " + node.failure.message}</Text>
      )}
      {node.state !== "waiting" || node.waitingReason === undefined ? null : (
        <Text dimColor={capabilities.supportsAnsi}>
          {"   " + node.waitingReason}
        </Text>
      )}
    </Box>
  );
}
