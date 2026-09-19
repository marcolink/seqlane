import { Box, Text, useAnimation } from "ink";
import { memo } from "react";
import { workTone } from "./theme.js";
import { encodeTerminalField } from "../terminal-field.js";
import { HumanTaskDetails } from "./task-details.js";
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
  readonly animate?: boolean;
  readonly lastSibling: boolean;
  readonly now: () => Date;
}
function HumanTreeRowComponent({
  row,
  capabilities,
  spinnerFrame,
  animate = false,
  lastSibling,
  now,
}: HumanTreeRowProps): React.JSX.Element {
  const { node } = row;
  // Keep the animation at the row boundary: each frame must also refresh the
  // active task's elapsed time when no execution event triggers a rerender.
  const animation = useAnimation({
    interval: 100,
    isActive: animate && node.state === "active",
  });
  const width = Math.max(1, capabilities.width ?? 80);
  const unicode = capabilities.supportsUnicode;
  const facts = nodeFacts(row, now());
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
              {statusSymbol(
                node.state,
                unicode,
                animate && node.state === "active"
                  ? animation.frame
                  : spinnerFrame,
              )}
            </Text>
            <Text {...tone}>
              {" " +
                disclosureSymbol(row, unicode) +
                encodeTerminalField(node.label, capabilities.redactions)}
            </Text>
          </Text>
        </Box>
        <Box paddingLeft={1} flexShrink={0} maxWidth={Math.max(1, width - 12)}>
          <Text {...tone} wrap="truncate-start">
            {facts}
          </Text>
        </Box>
      </Box>
      <HumanTaskDetails
        row={row}
        capabilities={capabilities}
        lastSibling={lastSibling}
      />
    </Box>
  );
}

function sameRails(
  left: readonly boolean[],
  right: readonly boolean[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function sameHumanTreeRowProps(
  left: HumanTreeRowProps,
  right: HumanTreeRowProps,
): boolean {
  const rowStable =
    left.row.node === right.row.node &&
    left.row.depth === right.row.depth &&
    left.row.omittedAncestorRailCount === right.row.omittedAncestorRailCount &&
    left.row.hasChildren === right.row.hasChildren &&
    left.row.isExpanded === right.row.isExpanded &&
    sameRails(left.row.ancestorRails, right.row.ancestorRails);
  const capabilitiesStable =
    left.capabilities.supportsAnsi === right.capabilities.supportsAnsi &&
    left.capabilities.supportsUnicode === right.capabilities.supportsUnicode &&
    left.capabilities.width === right.capabilities.width &&
    left.capabilities.height === right.capabilities.height &&
    left.capabilities.redactions === right.capabilities.redactions;
  const fallbackFrameStable =
    left.animate === true ||
    left.row.node.state !== "active" ||
    left.spinnerFrame === right.spinnerFrame;
  return (
    rowStable &&
    capabilitiesStable &&
    fallbackFrameStable &&
    left.animate === right.animate &&
    left.lastSibling === right.lastSibling &&
    left.now === right.now
  );
}

export const HumanTreeRow = memo(HumanTreeRowComponent, sameHumanTreeRowProps);
