import { Box, Text } from "ink";
import type { RunViewModel } from "../run-view-model.js";
import {
  getRunProjectionLimitNotice,
  getRunVisibleRows,
  getRunViewportRows,
} from "../run-view-model.js";
import type { HumanDisplayCapabilities } from "./format.js";
import { HumanTreeRow } from "./tree-row.js";

export interface HumanTreeProps {
  readonly view: RunViewModel;
  readonly capabilities: HumanDisplayCapabilities;
  readonly spinnerFrame: number;
  readonly sessionUiByInvocation: ReadonlyMap<string, string>;
}

export function HumanTree({
  view,
  capabilities,
  spinnerFrame,
  sessionUiByInvocation,
}: HumanTreeProps): React.JSX.Element {
  const limitNotice = getRunProjectionLimitNotice(view);
  const rows = getRunViewportRows(
    view,
    Math.max(1, (capabilities.height ?? 24) - 5),
  );
  const hasHiddenRows = rows.length < getRunVisibleRows(view).length;
  return (
    <Box flexDirection="column">
      {hasHiddenRows ? <Text dimColor>… scroll with ↑↓ …</Text> : null}
      {rows.map((row) => (
        <HumanTreeRow
          key={row.node.invocationId}
          row={row}
          capabilities={capabilities}
          spinnerFrame={spinnerFrame}
          sessionUiUrl={sessionUiByInvocation.get(row.node.invocationId)}
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
