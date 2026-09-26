import { Box, Text } from "ink";
import type { InvocationActivityEvent } from "@seqlane/protocol";
import type { RunNode, RunVisibleRow } from "../run-view-model.js";
import type { HumanDisplayCapabilities } from "./format.js";
import { activityTone, workTone } from "./theme.js";
import { encodeTerminalField, encodeTerminalJson } from "../terminal-field.js";
import { formatValidationDetails } from "../output-details.js";
import { HumanModelObservationDetails } from "./observation-details.js";

function contextParts(node: RunNode): {
  readonly model?: string;
  readonly metadata: readonly string[];
} {
  const plannedModel =
    node.session && "model" in node.session
      ? node.session.model?.model.model
      : undefined;
  const model =
    node.output.metrics?.model ??
    node.output.metrics?.modelSelection?.model.model ??
    plannedModel;
  const metadata = [
    node.workspace === undefined
      ? undefined
      : node.workspace === "exclusive"
        ? "worktree"
        : "shared",
    node.session === undefined
      ? undefined
      : node.session.type === "isolated"
        ? "delegated"
        : node.session.type === "reuse"
          ? "reused"
          : "forked",
  ].filter((value): value is string => value !== undefined);
  return { ...(model === undefined ? {} : { model }), metadata };
}

function taskDetailLines(node: RunNode): string[] {
  const lines: string[] = [];
  if (node.state === "retrying" && node.retry !== undefined)
    lines.push(node.retry.lastError.message);
  if (node.state === "waiting" && node.waitingReason !== undefined)
    lines.push(node.waitingReason);
  if (node.failure) lines.push(node.failure.message);
  if (
    (!isTerminal(node) || node.state === "failed") &&
    node.validation &&
    (node.validation.verdict !== "unknown" ||
      node.validation.issues.length > 0 ||
      node.validation.evidence !== undefined)
  )
    lines.push(formatValidationDetails(node.validation));
  if (node.output.truncated)
    lines.push(
      `[output truncated original_bytes=${node.output.originalBytes ?? 0} omitted_bytes=${node.output.omittedBytes ?? 0}]`,
    );
  return lines.filter((line): line is string => Boolean(line));
}

function observabilityLines(node: RunNode): string[] {
  const lines: string[] = [];
  if (node.input !== undefined) {
    lines.push("input: " + encodeTerminalJson(node.input));
  }
  if (node.result !== undefined) {
    lines.push("result: " + encodeTerminalJson(node.result));
  }
  for (const activity of node.activityDetails.values()) {
    if (
      activity.input === undefined &&
      activity.output === undefined &&
      activity.activityMetadata === undefined
    ) {
      continue;
    }
    lines.push("activity: " + encodeTerminalJson(activity));
  }
  return lines;
}

function HumanObservabilityDetails({
  lines,
}: {
  readonly lines: readonly string[];
}): React.JSX.Element | null {
  if (lines.length === 0) return null;
  return (
    <>
      {lines.map((line, index) => (
        <Text key={index}>{line}</Text>
      ))}
    </>
  );
}

function isTerminal(node: RunNode): boolean {
  return (
    node.state === "succeeded" ||
    node.state === "failed" ||
    node.state === "skipped" ||
    node.state === "cancelled"
  );
}

function HumanLiveActivityLine({
  event,
  capabilities,
}: {
  readonly event: InvocationActivityEvent;
  readonly capabilities: HumanDisplayCapabilities;
}): React.JSX.Element {
  const tone = activityTone(event.kind, capabilities.supportsAnsi);
  const value = event.message ?? event.state;
  return (
    <Text {...tone}>
      {"["}
      <Text>{event.kind}</Text>
      {"] "}
      <Text>
        {encodeTerminalField(event.name, capabilities.redactions)}
      </Text>{" "}
      <Text>{encodeTerminalField(value, capabilities.redactions)}</Text>
    </Text>
  );
}

function HumanProgressLine({
  value,
  capabilities,
}: {
  readonly value: string;
  readonly capabilities: HumanDisplayCapabilities;
}): React.JSX.Element {
  return (
    <Text
      color={capabilities.supportsAnsi ? "gray" : undefined}
      dimColor={capabilities.supportsAnsi}
    >
      {encodeTerminalField(value, capabilities.redactions)}
    </Text>
  );
}

function HumanLiveActivityDetails({
  node,
  capabilities,
}: {
  readonly node: RunNode;
  readonly capabilities: HumanDisplayCapabilities;
}): React.JSX.Element | null {
  const activities = [...node.liveActivities.values()];
  const activityMessages = new Set(
    activities
      .map((activity) => activity.message)
      .filter((message): message is string => message !== undefined),
  );
  const hasProgress =
    node.activity !== undefined && !activityMessages.has(node.activity);
  if (!hasProgress && activities.length === 0) return null;
  return (
    <>
      {hasProgress ? (
        <HumanProgressLine
          value={node.activity ?? ""}
          capabilities={capabilities}
        />
      ) : null}
      {activities.map((event) => (
        <HumanLiveActivityLine
          key={event.activityId}
          event={event}
          capabilities={capabilities}
        />
      ))}
    </>
  );
}

function HumanTaskContext({
  node,
  capabilities,
}: {
  readonly node: RunNode;
  readonly capabilities: HumanDisplayCapabilities;
}): React.JSX.Element | null {
  const { model, metadata } = contextParts(node);
  if (model === undefined && metadata.length === 0) return null;
  const separator = " · ";
  return (
    <Text dimColor={capabilities.supportsAnsi}>
      {model === undefined ? null : (
        <Text color={capabilities.supportsAnsi ? "blueBright" : undefined}>
          {encodeTerminalField(model, capabilities.redactions)}
        </Text>
      )}
      {metadata.map((value, index) => (
        <Text key={value}>
          {model === undefined && index === 0 ? null : (
            <Text dimColor={capabilities.supportsAnsi}>{separator}</Text>
          )}
          <Text
            color={
              capabilities.supportsAnsi
                ? index === 0
                  ? "cyanBright"
                  : "magentaBright"
                : undefined
            }
          >
            {encodeTerminalField(value, capabilities.redactions)}
          </Text>
        </Text>
      ))}
    </Text>
  );
}

function hasUsageDetails(node: RunNode): boolean {
  return (
    node.output.metrics?.tokens !== undefined ||
    node.toolUsage.size > 0 ||
    node.skillUsage.size > 0
  );
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
  const hasUsage = hasUsageDetails(node);
  const terminal = isTerminal(node);
  const context = contextParts(node);
  const details = taskDetailLines(node);
  const observability = observabilityLines(node);
  const hasContext = context.model !== undefined || context.metadata.length > 0;
  const hasLive =
    !terminal && (node.activity !== undefined || node.liveActivities.size > 0);
  const hasSummary = terminal && (node.observations.size > 0 || hasUsage);
  if (
    !hasContext &&
    details.length === 0 &&
    observability.length === 0 &&
    !hasLive &&
    !hasSummary
  )
    return null;
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
        <HumanTaskContext node={node} capabilities={capabilities} />
        {terminal ? null : (
          <HumanLiveActivityDetails node={node} capabilities={capabilities} />
        )}
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
        <HumanObservabilityDetails lines={observability} />
        {terminal ? (
          <HumanModelObservationDetails
            capabilities={capabilities}
            tokens={node.output.metrics?.tokens}
            cost={node.output.metrics?.cost}
            toolUsage={node.toolUsage}
            skillUsage={node.skillUsage}
          />
        ) : null}
      </Box>
    </Box>
  );
}
