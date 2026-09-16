import { Box, Text } from "ink";
import { useMemo } from "react";
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
  readonly animate?: boolean;
}
export function HumanTree({
  view,
  capabilities,
  spinnerFrame,
  animate = false,
}: HumanTreeProps): React.JSX.Element {
  const notice = getRunProjectionLimitNotice(view);
  const rows = useMemo(
    () => getRunVisibleRows(view),
    [view.nodes, view.presentation, view.rootInvocationIds],
  );
  return (
    <Box flexDirection="column">
      {rows.map((row) => {
        const siblings =
          row.node.parentInvocationId === undefined
            ? view.rootInvocationIds
            : (view.childrenByParent.get(row.node.parentInvocationId) ?? []);
        return (
          <HumanTreeRow
            key={row.node.invocationId}
            row={row}
            capabilities={capabilities}
            spinnerFrame={spinnerFrame}
            animate={animate}
            lastSibling={siblings.at(-1) === row.node.invocationId}
            now={view.now}
          />
        );
      })}
      {notice === undefined ? null : (
        <Text color={capabilities.supportsAnsi ? "yellow" : undefined}>
          {notice}
        </Text>
      )}
    </Box>
  );
}
