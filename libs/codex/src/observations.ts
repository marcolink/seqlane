import type { ModelSelection } from "@seqlane/core";
import { jsonValueSchema } from "@seqlane/core";
import type { JsonValue } from "@seqlane/core";
import type { SeqlaneObservation } from "@seqlane/agent-adapter";

type ObservationAvailability = NonNullable<
  SeqlaneObservation["availability"]
>[number];

export interface CodexModelObservationInput {
  readonly invocationId: string;
  readonly state: SeqlaneObservation["state"];
  readonly selection?: ModelSelection;
  readonly request?: unknown;
  readonly responseId?: string;
  readonly response?: unknown;
  readonly usage?: unknown;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly error?: string;
}

function jsonValue(
  value: unknown,
  path: string,
  availability: ObservationAvailability[],
): JsonValue | undefined {
  const parsed = jsonValueSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  // A partial SDK payload is misleading: nested salvage can silently drop
  // array entries, invoke getters, or recurse forever on cyclic objects.
  availability.push({ path, reason: "not-json-representable" });
  return undefined;
}

/** Builds the canonical model exchange from the complete Codex SDK values. */
export function createCodexModelObservation(
  input: CodexModelObservationInput,
): SeqlaneObservation {
  const availability: ObservationAvailability[] = [];
  const request =
    input.request === undefined
      ? undefined
      : jsonValue(input.request, "model.request", availability);
  const response =
    input.response === undefined
      ? undefined
      : jsonValue(input.response, "model.response", availability);
  const usage =
    input.usage === undefined
      ? undefined
      : jsonValue(input.usage, "model.usage", availability);
  availability.push({
    path: "model.response.cost",
    reason: "source-unavailable",
  });
  return {
    observationId: `${input.invocationId}:model:0`,
    kind: "model",
    state: input.state,
    attemptIndex: 0,
    model: {
      operation: "chat",
      ...(input.selection === undefined
        ? {}
        : {
            provider: input.selection.model.provider,
            model: input.selection.model.model,
          }),
      ...(input.responseId === undefined
        ? {}
        : { responseId: input.responseId }),
      ...(request === undefined ? {} : { request }),
      ...(response === undefined ? {} : { response }),
      ...(usage === undefined ? {} : { usage }),
      ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
      ...(input.endedAt === undefined ? {} : { endedAt: input.endedAt }),
      ...(input.error === undefined ? {} : { error: input.error }),
    },
    availability,
  };
}
