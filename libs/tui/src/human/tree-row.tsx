import { Box, Text } from "ink";
import type { RunVisibleRow } from "../run-view-model.js";
import {
  statusColor,
  statusSymbol,
  formatDuration,
  truncateTerminalText,
  treePrefix,
  type HumanDisplayCapabilities,
} from "./format.js";

export interface HumanTreeRowProps {
  readonly row: RunVisibleRow;
  readonly capabilities: HumanDisplayCapabilities;
  readonly focused: boolean;
  readonly spinnerFrame: number;
  readonly sessionUiUrl?: string;
}

export function HumanTreeRow({
  row,
  capabilities,
  focused,
  spinnerFrame,
  sessionUiUrl,
}: HumanTreeRowProps): React.JSX.Element {
  const focusMarker = focused && !capabilities.supportsAnsi ? ">" : " ";
  const width = Math.max(1, capabilities.width ?? 80);
  const facts =
    row.node.retry === undefined
      ? row.node.state === "waiting"
        ? "waiting"
        : row.node.failure === undefined
          ? row.node.aggregate.total > 1
            ? `${row.node.aggregate.succeeded}/${row.node.aggregate.total}`
            : formatDuration(row.node.elapsedMs)
          : "failed"
      : `retry ${row.node.retry.attempt}`;
  const prefix = treePrefix(row, capabilities);
  const fixed = 4 + prefix.length + facts.length;
  const label = truncateTerminalText(
    row.node.label,
    Math.max(1, width - fixed),
    capabilities.supportsUnicode,
  );
  return (
    <Box flexDirection="column">
      <Box width={width}>
        <Text
          inverse={focused && capabilities.supportsAnsi}
          color={
            capabilities.supportsAnsi ? statusColor(row.node.state) : undefined
          }
        >
          {focusMarker +
            statusSymbol(
              row.node.state,
              capabilities.supportsUnicode,
              spinnerFrame,
            )}
        </Text>
        <Text inverse={focused && capabilities.supportsAnsi}>
          {" " + prefix + " " + label}
        </Text>
        {facts === "" ? null : (
          <Box flexGrow={1} justifyContent="flex-end">
            <Text dimColor={!focused}>{facts}</Text>
          </Box>
        )}
      </Box>
      {sessionUiUrl === undefined ? null : (
        <Text dimColor>{"    Session UI: " + sessionUiUrl}</Text>
      )}
    </Box>
  );
}
