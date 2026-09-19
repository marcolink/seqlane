import { Box, Text } from "ink";
import type { InvocationObservationEvent } from "@seqlane/protocol";
import { encodeTerminalField } from "../terminal-field.js";
import { modelObservationIdentity } from "../observation-details.js";
import type { HumanDisplayCapabilities } from "./format.js";

function terminalValue(
  value: string | number,
  redactions: readonly string[],
): string {
  return encodeTerminalField(String(value), redactions);
}

function modelSummary(
  event: InvocationObservationEvent,
  capabilities: HumanDisplayCapabilities,
): React.JSX.Element {
  const redactions = capabilities.redactions ?? [];
  return (
    <Text>
      {"model "}
      <Text>{terminalValue(modelObservationIdentity(event), redactions)}</Text>
      {" state="}
      <Text>{terminalValue(event.state, redactions)}</Text>
      {" attempt="}
      <Text>{terminalValue(event.attemptIndex ?? 0, redactions)}</Text>
      {event.model.request === undefined ? null : " request=present"}
      {event.model.response === undefined ? null : " response=present"}
    </Text>
  );
}

function modelDetail(event: InvocationObservationEvent): React.JSX.Element {
  return (
    <Text>
      {"model observation="}
      <Text>{terminalValue(event.observationId, [])}</Text>{" "}
      <Text>{terminalValue(JSON.stringify(event.model), [])}</Text>
    </Text>
  );
}

export function HumanModelObservationDetails({
  events,
  capabilities,
  showDetails,
  failure,
}: {
  readonly events: Iterable<InvocationObservationEvent>;
  readonly capabilities: HumanDisplayCapabilities;
  readonly showDetails: boolean;
  readonly failure: boolean;
}): React.JSX.Element | null {
  const observations = [...events];
  const latest = observations.at(-1);
  if (latest === undefined) return null;

  const textProps = {
    dimColor: capabilities.supportsAnsi && !failure,
    color: capabilities.supportsAnsi && failure ? ("red" as const) : undefined,
  };
  return (
    <Box flexDirection="column">
      <Text {...textProps}>model exchanges={observations.length}</Text>
      <Text {...textProps}>{modelSummary(latest, capabilities)}</Text>
      {!showDetails
        ? null
        : observations.map((observation) => (
            <Text {...textProps} key={observation.observationId}>
              {modelDetail(observation)}
            </Text>
          ))}
    </Box>
  );
}
