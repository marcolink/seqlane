import { Box, Text } from "ink";
import type { InvocationObservationEvent } from "@seqlane/protocol";
import { encodeTerminalField } from "../terminal-field.js";
import { modelObservationIdentity } from "../observation-details.js";
import type { HumanDisplayCapabilities } from "./format.js";

type TokenCounts = {
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
};

type SummaryTextProps = {
  readonly dimColor: boolean;
  readonly color?: string;
};

interface ModelSummaryInput {
  readonly event: InvocationObservationEvent | undefined;
  readonly capabilities: HumanDisplayCapabilities;
  readonly tokens: TokenCounts | undefined;
  readonly toolUsage: ReadonlyMap<string, number>;
  readonly skillUsage: ReadonlyMap<string, number>;
  readonly textProps: SummaryTextProps;
}

function terminalValue(
  value: string | number,
  redactions: readonly string[],
): string {
  return encodeTerminalField(String(value), redactions);
}

function modelSummary({
  event,
  capabilities,
  tokens,
  toolUsage,
  skillUsage,
  textProps,
}: ModelSummaryInput): React.JSX.Element {
  const redactions = capabilities.redactions ?? [];
  return (
    <Box flexDirection="column">
      {event === undefined ? null : (
        <Text {...textProps}>
          <Text>{summaryLabel("model")}</Text>
          <Text>
            {terminalValue(modelObservationIdentity(event), redactions)}
          </Text>
        </Text>
      )}
      {tokens === undefined ? null : (
        <Text {...textProps}>
          <Text>{summaryLabel("tokens")}</Text>
          {"input="}
          <Text>{terminalValue(tokens.input, redactions)}</Text>
          {" · output="}
          <Text>{terminalValue(tokens.output, redactions)}</Text>
          {" · reasoning="}
          <Text>{terminalValue(tokens.reasoning, redactions)}</Text>
          {" · cacheRead="}
          <Text>{terminalValue(tokens.cacheRead, redactions)}</Text>
          {" · cacheWrite="}
          <Text>{terminalValue(tokens.cacheWrite, redactions)}</Text>
        </Text>
      )}
      {usageSummary("tools", toolUsage, redactions, textProps)}
      {usageSummary("skills", skillUsage, redactions, textProps)}
    </Box>
  );
}

function summaryLabel(label: "model" | "tokens" | "tools" | "skills"): string {
  return label.padEnd(8);
}

function usageSummary(
  label: "tools" | "skills",
  usage: ReadonlyMap<string, number>,
  redactions: readonly string[],
  textProps: SummaryTextProps,
): React.JSX.Element | null {
  if (usage.size === 0) return null;
  return (
    <Text {...textProps}>
      <Text>{summaryLabel(label)}</Text>
      {[...usage].map(([name, count], index) => (
        <Text key={name}>
          {index === 0 ? "" : " · "}
          <Text>{terminalValue(name, redactions)}</Text>
          {"="}
          <Text>{terminalValue(count, redactions)}</Text>
        </Text>
      ))}
    </Text>
  );
}

export function HumanModelObservationDetails({
  events,
  capabilities,
  failure,
  tokens,
  toolUsage,
  skillUsage,
}: {
  readonly events: Iterable<InvocationObservationEvent>;
  readonly capabilities: HumanDisplayCapabilities;
  readonly failure: boolean;
  readonly tokens?: TokenCounts;
  readonly toolUsage: ReadonlyMap<string, number>;
  readonly skillUsage: ReadonlyMap<string, number>;
}): React.JSX.Element | null {
  const observations = [...events];
  const latest = observations.at(-1);
  if (
    latest === undefined &&
    tokens === undefined &&
    toolUsage.size === 0 &&
    skillUsage.size === 0
  )
    return null;

  const textProps = {
    dimColor: capabilities.supportsAnsi && !failure,
    color: capabilities.supportsAnsi && failure ? ("red" as const) : undefined,
  };
  return modelSummary({
    event: latest,
    capabilities,
    tokens,
    toolUsage,
    skillUsage,
    textProps,
  });
}
