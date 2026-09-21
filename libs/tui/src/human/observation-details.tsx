import { Box, Text } from "ink";
import { encodeTerminalField } from "../terminal-field.js";
import type { HumanDisplayCapabilities } from "./format.js";
import { formatReportedCost } from "./usage.js";

type TokenCounts = {
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly total?: number;
};

type SummaryColor =
  | "cyanBright"
  | "greenBright"
  | "magentaBright"
  | "whiteBright"
  | "yellowBright";

function terminalValue(
  value: string | number,
  capabilities: HumanDisplayCapabilities,
): string {
  return encodeTerminalField(String(value), capabilities.redactions);
}

function SummaryLabel({
  children,
  capabilities,
}: {
  readonly children: string;
  readonly capabilities: HumanDisplayCapabilities;
}): React.JSX.Element {
  return <Text dimColor={capabilities.supportsAnsi}>{children}</Text>;
}

function SummaryValue({
  value,
  capabilities,
  color = "whiteBright",
}: {
  readonly value: string | number;
  readonly capabilities: HumanDisplayCapabilities;
  readonly color?: SummaryColor;
}): React.JSX.Element {
  return (
    <Text color={capabilities.supportsAnsi ? color : undefined}>
      {terminalValue(value, capabilities)}
    </Text>
  );
}

function SummarySeparator({
  capabilities,
}: {
  readonly capabilities: HumanDisplayCapabilities;
}): React.JSX.Element {
  return <Text dimColor={capabilities.supportsAnsi}> · </Text>;
}

function totalTokens(tokens: TokenCounts): number {
  return tokens.total ?? tokens.input + tokens.output + tokens.reasoning;
}

function compactTokenCount(count: number): string {
  if (count < 1_000) return String(count);
  return `${Math.floor(count / 100) / 10}k`;
}

function TokenMetric({
  label,
  value,
  capabilities,
}: {
  readonly label: string;
  readonly value: number;
  readonly capabilities: HumanDisplayCapabilities;
}): React.JSX.Element {
  return (
    <Text>
      <SummaryLabel capabilities={capabilities}>{label}</SummaryLabel>{" "}
      <SummaryValue
        capabilities={capabilities}
        color="cyanBright"
        value={compactTokenCount(value)}
      />
    </Text>
  );
}

function UsageValues({
  label,
  usage,
  color,
  capabilities,
}: {
  readonly label: "tools" | "skills";
  readonly usage: ReadonlyMap<string, number>;
  readonly color: SummaryColor;
  readonly capabilities: HumanDisplayCapabilities;
}): React.JSX.Element {
  const entries = [...usage];
  return (
    <Text>
      <SummaryLabel capabilities={capabilities}>{label}</SummaryLabel>{" "}
      {entries.length === 0 ? (
        <SummaryValue capabilities={capabilities} value="none" />
      ) : (
        entries.map(([name, count], index) => (
          <Text key={name}>
            {index === 0 ? null : (
              <SummarySeparator capabilities={capabilities} />
            )}
            <SummaryValue
              capabilities={capabilities}
              color={color}
              value={name}
            />
            {"×"}
            <SummaryValue capabilities={capabilities} value={count} />
          </Text>
        ))
      )}
    </Text>
  );
}

function SummaryTotals({
  tokens,
  cost,
  capabilities,
}: {
  readonly tokens: TokenCounts | undefined;
  readonly cost: number | undefined;
  readonly capabilities: HumanDisplayCapabilities;
}): React.JSX.Element | null {
  if (tokens === undefined && cost === undefined) return null;
  return (
    <Text>
      {tokens === undefined ? null : (
        <>
          <SummaryValue
            capabilities={capabilities}
            color="cyanBright"
            value={compactTokenCount(totalTokens(tokens))}
          />
          {" tokens"}
        </>
      )}
      {cost === undefined ? null : (
        <>
          {tokens === undefined ? null : (
            <SummarySeparator capabilities={capabilities} />
          )}
          <SummaryValue
            capabilities={capabilities}
            color="greenBright"
            value={formatReportedCost(cost)}
          />
        </>
      )}
    </Text>
  );
}

export function HumanModelObservationDetails({
  capabilities,
  tokens,
  cost,
  toolUsage,
  skillUsage,
}: {
  readonly capabilities: HumanDisplayCapabilities;
  readonly tokens?: TokenCounts;
  readonly cost?: number;
  readonly toolUsage: ReadonlyMap<string, number>;
  readonly skillUsage: ReadonlyMap<string, number>;
}): React.JSX.Element | null {
  if (
    tokens === undefined &&
    cost === undefined &&
    toolUsage.size === 0 &&
    skillUsage.size === 0
  )
    return null;

  return (
    <Box flexDirection="column">
      <SummaryTotals capabilities={capabilities} tokens={tokens} cost={cost} />
      {tokens === undefined ? null : (
        <Text>
          <TokenMetric
            capabilities={capabilities}
            label="input"
            value={tokens.input}
          />
          <SummarySeparator capabilities={capabilities} />
          <TokenMetric
            capabilities={capabilities}
            label="output"
            value={tokens.output}
          />
          <SummarySeparator capabilities={capabilities} />
          <TokenMetric
            capabilities={capabilities}
            label="reasoning"
            value={tokens.reasoning}
          />
          <SummarySeparator capabilities={capabilities} />
          <TokenMetric
            capabilities={capabilities}
            label="cache read"
            value={tokens.cacheRead}
          />
          <SummarySeparator capabilities={capabilities} />
          <TokenMetric
            capabilities={capabilities}
            label="cache write"
            value={tokens.cacheWrite}
          />
        </Text>
      )}
      <Text>
        <UsageValues
          capabilities={capabilities}
          color="cyanBright"
          label="tools"
          usage={toolUsage}
        />
        <SummarySeparator capabilities={capabilities} />
        <UsageValues
          capabilities={capabilities}
          color="magentaBright"
          label="skills"
          usage={skillUsage}
        />
      </Text>
    </Box>
  );
}
