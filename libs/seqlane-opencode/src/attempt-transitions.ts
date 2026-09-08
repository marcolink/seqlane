import type { OpenCodeActivity } from "./protocol.js";
import type {
  OpenCodeEventObservation,
  OpenCodeLegacyToolObservation,
  OpenCodeToolObservation,
} from "./observations.js";

function stringField(
  details: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = details[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

interface ActivityIdentity {
  readonly kind: OpenCodeActivity["kind"];
  readonly name: string;
}

const activityStates = new Map<string, OpenCodeActivity["state"]>([
  ["pending", "started"],
  ["running", "started"],
  ["called", "started"],
  ["progress", "progress"],
  ["completed", "succeeded"],
  ["success", "succeeded"],
]);

function observationIdentity(observation: OpenCodeEventObservation): string {
  return observation.kind === "assistant"
    ? JSON.stringify([
        "assistant",
        observation.sessionID,
        observation.messageID,
      ])
    : JSON.stringify(["tool", observation.messageID, observation.callID]);
}

function observationIsTerminal(observation: OpenCodeEventObservation): boolean {
  return observation.kind === "assistant"
    ? observation.completed !== undefined || observation.error !== undefined
    : observation.status === "completed" || observation.status === "error";
}

function activityIdentity(
  tool: string,
  input: Record<string, unknown> | undefined,
  metadata: Record<string, unknown> | undefined,
  previous: ActivityIdentity | undefined,
): ActivityIdentity | undefined {
  if (tool !== "skill") return { kind: "tool", name: tool };
  const name =
    stringField(metadata ?? {}, "name") ??
    stringField(input ?? {}, "name") ??
    (previous?.kind === "skill" ? previous.name : undefined);
  return name === undefined ? undefined : { kind: "skill", name };
}

function activityState(
  status:
    OpenCodeToolObservation["status"] | OpenCodeLegacyToolObservation["status"],
): OpenCodeActivity["state"] {
  return activityStates.get(status) ?? "failed";
}

function activityFromToolObservation(
  observation: OpenCodeToolObservation | OpenCodeLegacyToolObservation,
  activityIdentities: Map<string, ActivityIdentity>,
): OpenCodeActivity | undefined {
  const callID = observation.callID;
  const identity =
    observation.tool === undefined
      ? activityIdentities.get(callID)
      : activityIdentity(
          observation.tool,
          observation.input,
          observation.metadata,
          activityIdentities.get(callID),
        );
  if (
    identity === undefined ||
    callID.length > 256 ||
    identity.name.length > 256
  )
    return undefined;
  activityIdentities.set(callID, identity);
  const state = activityState(observation.status);
  return {
    activityId: callID,
    kind: identity.kind,
    name: identity.name,
    state,
    ...(observation.input === undefined ? {} : { input: observation.input }),
    ...(observation.output === undefined ? {} : { output: observation.output }),
    ...(observation.metadata === undefined
      ? {}
      : { metadata: observation.metadata }),
    ...(observation.startedAt === undefined
      ? {}
      : { startedAt: observation.startedAt }),
    ...(observation.endedAt === undefined
      ? {}
      : { endedAt: observation.endedAt }),
    ...(state === "failed" ? { message: "Tool failed" } : {}),
  };
}

export interface AttemptTransitionCallbacks {
  readonly onActivity: ((activity: OpenCodeActivity) => void) | undefined;
  readonly onObservation:
    ((observation: OpenCodeEventObservation) => void) | undefined;
}

export interface AttemptTransitionDispatcher {
  readonly observation: (observation: OpenCodeEventObservation) => void;
  readonly legacyTool: (observation: OpenCodeLegacyToolObservation) => void;
}

/** Owns per-attempt event identity and terminal transitions before fan-out. */
export function createAttemptTransitionDispatcher({
  onActivity,
  onObservation,
}: AttemptTransitionCallbacks): AttemptTransitionDispatcher {
  const activityIdentities = new Map<string, ActivityIdentity>();
  const terminalObservations = new Set<string>();

  const dispatchObservation = (observation: OpenCodeEventObservation): void => {
    const identity = observationIdentity(observation);
    if (terminalObservations.has(identity)) return;
    if (observationIsTerminal(observation)) terminalObservations.add(identity);
    onObservation?.(observation);
    if (observation.kind !== "tool") return;
    const activity = activityFromToolObservation(
      observation,
      activityIdentities,
    );
    if (activity !== undefined) onActivity?.(activity);
  };

  const dispatchLegacyTool = (
    observation: OpenCodeLegacyToolObservation,
  ): void => {
    const identity = JSON.stringify(["legacy-tool", observation.callID]);
    if (terminalObservations.has(identity)) return;
    const terminal =
      observation.status === "completed" ||
      observation.status === "error" ||
      observation.status === "success" ||
      observation.status === "failed";
    if (terminal) terminalObservations.add(identity);
    const activity = activityFromToolObservation(
      observation,
      activityIdentities,
    );
    if (activity !== undefined) onActivity?.(activity);
  };

  return { observation: dispatchObservation, legacyTool: dispatchLegacyTool };
}
