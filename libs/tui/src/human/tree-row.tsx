import { Box, Text } from "ink";
import type { RunVisibleRow } from "../run-view-model.js";
import {
  statusColor,
  statusSymbol,
  treePrefix,
  type HumanDisplayCapabilities,
} from "./format.js";

export interface HumanTreeRowProps {
  readonly row: RunVisibleRow;
  readonly capabilities: HumanDisplayCapabilities;
  readonly focused: boolean;
  readonly spinnerFrame: number;
}

export function HumanTreeRow({
  row,
  capabilities,
  focused,
  spinnerFrame,
}: HumanTreeRowProps): React.JSX.Element {
  const focusMarker = focused && !capabilities.supportsAnsi ? ">" : " ";
  return (
    <Box>
      <Text
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
      <Text>{" " + treePrefix(row, capabilities) + " " + row.node.label}</Text>
    </Box>
  );
}
