import { Box, Text } from "ink";
import type { RunViewModel } from "../run-view-model.js";
import {
  getRunProjectionLimitNotice,
  getRunVisibleRows,
} from "../run-view-model.js";
import type { HumanDisplayCapabilities } from "./format.js";
import { HumanTreeRow } from "./tree-row.js";

export interface HumanTreeProps {
  readonly view: RunViewModel;
  readonly capabilities: HumanDisplayCapabilities;
  readonly spinnerFrame: number;
}

export function HumanTree({
  view,
  capabilities,
  spinnerFrame,
}: HumanTreeProps): React.JSX.Element {
  const limitNotice = getRunProjectionLimitNotice(view);
  return (
    <Box flexDirection="column">
      {getRunVisibleRows(view).map((row) => (
        <HumanTreeRow
          key={row.node.invocationId}
          row={row}
          capabilities={capabilities}
          spinnerFrame={spinnerFrame}
          focused={
            view.presentation.get(row.node.invocationId)?.isFocused ?? false
          }
        />
      ))}
      {limitNotice === undefined ? null : (
        <Text color="yellow">{limitNotice}</Text>
      )}
    </Box>
  );
}
