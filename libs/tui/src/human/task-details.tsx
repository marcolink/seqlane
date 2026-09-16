import { Box, Text } from "ink";
import type { RunNode, RunVisibleRow } from "../run-view-model.js";
import type { HumanDisplayCapabilities } from "./format.js";
import { workTone } from "./theme.js";
import { encodeTerminalField } from "../terminal-field.js";
import { usageSummary } from "./usage.js";
import { formatCIValidationDetails } from "../output-details.js";

function contextSummary(node: RunNode): string {
  const parts: string[] = [];
  if (node.workspace) parts.push(`workspace ${node.workspace}`);
  if (node.session)
    parts.push(
      `session ${node.session.type === "isolated" ? "new" : node.session.type === "reuse" ? "reused" : "forked"} (planned)`,
    );
  const plannedModel =
    node.session && "model" in node.session
      ? node.session.model?.model.model
      : undefined;
  const model =
    node.output.metrics?.model ??
    node.output.metrics?.modelSelection?.model.model ??
    plannedModel;
  if (model) parts.push(model);
  if (node.iteration !== undefined) parts.push(`iteration ${node.iteration}`);
  return parts.join(" · ");
}

/** Native flex borders stretch with wrapped content; no line-height estimation. */
export function HumanTaskDetails({
  row,
  capabilities,
  lastSibling,
}: {
  readonly row: RunVisibleRow;
  readonly capabilities: HumanDisplayCapabilities;
  readonly lastSibling: boolean;
}): React.JSX.Element | null {
  const { node } = row;
  const expanded =
    node.state === "active" ||
    node.state === "retrying" ||
    node.state === "waiting";
  const lines = expanded
    ? [
        node.state === "retrying"
          ? node.retry?.lastError.message
          : (node.waitingReason ?? node.activity ?? node.phase),
        contextSummary(node),
        usageSummary(node),
      ]
    : [];
  if (node.failure) lines.push(node.failure.message);
  if (
    node.validation &&
    (node.validation.verdict !== "unknown" ||
      node.validation.issues.length > 0 ||
      node.validation.evidence !== undefined)
  )
    lines.push(formatCIValidationDetails(node.validation));
  if (node.output.truncated)
    lines.push(
      `[output truncated original_bytes=${node.output.originalBytes ?? 0} omitted_bytes=${node.output.omittedBytes ?? 0}]`,
    );
  const details = lines.filter((line): line is string => Boolean(line));
  if (details.length === 0) return null;
  const limit = Math.min(
    32,
    Math.max(0, Math.floor(((capabilities.width ?? 80) - 24) / 3)),
  );
  const rails = [
    ...(limit === 0 ? [] : row.ancestorRails.slice(-limit)),
    !lastSibling,
  ];
  const tone = workTone(node.kind, node.state, capabilities.supportsAnsi);
  return (
    <Box width={capabilities.width ?? 80}>
      {rails.map((continues, index) => (
        <Box
          key={index}
          width={3}
          flexShrink={0}
          borderStyle={capabilities.supportsUnicode ? "single" : "classic"}
          borderLeft={continues}
          borderRight={false}
          borderTop={false}
          borderBottom={false}
          borderColor={tone.color}
        />
      ))}
      <Box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        minWidth={0}
        paddingLeft={2}
      >
        {details.map((line, index) => (
          <Text
            key={index}
            dimColor={capabilities.supportsAnsi && !node.failure}
            color={
              capabilities.supportsAnsi && node.failure ? "red" : undefined
            }
          >
            {encodeTerminalField(line, capabilities.redactions)}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
