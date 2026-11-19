import type { ModelSelection } from "@seqlane/core";
import type { AgentAdapterRequest } from "@seqlane/agent-adapter";
import { createCodexModelObservation } from "./observations.js";

type Observation = Parameters<
  NonNullable<AgentAdapterRequest["onObservation"]>
>[0];

interface TerminalObservationDetails {
  readonly responseId?: string;
  readonly response?: unknown;
  readonly usage?: unknown;
  readonly endedAt?: number;
  readonly error?: string;
}

/** Owns the started/terminal callback sequence for one Codex model turn. */
export function createCodexObservationLifecycle(
  request: AgentAdapterRequest,
  now: () => number,
) {
  let startedAt: number | undefined;
  let terminalSent = false;
  let requestValue: unknown;
  let selection: ModelSelection | undefined;
  let responseId: string | undefined;
  let response: unknown;
  let usage: unknown;
  let sinkFailed = false;
  let sinkCause: unknown;

  const emit = (
    state: Observation["state"],
    details: TerminalObservationDetails = {},
  ): void => {
    if (state === "started") startedAt = now();
    else terminalSent = true;
    const observedResponseId = details.responseId ?? responseId;
    const observedResponse =
      details.response === undefined ? response : details.response;
    const observedUsage = details.usage === undefined ? usage : details.usage;
    try {
      request.onObservation?.(
        createCodexModelObservation({
          invocationId: request.invocationId,
          state,
          selection,
          request: requestValue,
          ...(observedResponseId === undefined
            ? {}
            : { responseId: observedResponseId }),
          ...(observedResponse === undefined
            ? {}
            : { response: observedResponse }),
          ...(observedUsage === undefined ? {} : { usage: observedUsage }),
          ...(startedAt === undefined ? {} : { startedAt }),
          ...(details.endedAt === undefined
            ? {}
            : { endedAt: details.endedAt }),
          ...(details.error === undefined ? {} : { error: details.error }),
        }),
      );
    } catch (cause) {
      sinkFailed = true;
      sinkCause = cause;
      throw cause;
    }
  };

  return {
    setSelection(value: ModelSelection | undefined): void {
      selection = value;
    },
    sinkFailure(): { readonly failed: boolean; readonly cause: unknown } {
      return { failed: sinkFailed, cause: sinkCause };
    },
    exchange(details: {
      readonly responseId?: string;
      readonly response: unknown;
      readonly usage?: unknown;
    }): void {
      if (details.responseId !== undefined) responseId = details.responseId;
      response = details.response;
      if (details.usage !== undefined) usage = details.usage;
    },
    started(value: unknown): void {
      requestValue = value;
      emit("started");
    },
    succeeded(details: TerminalObservationDetails): void {
      emit("succeeded", details);
    },
    failed(cause: unknown, cancelled: boolean): void {
      if (startedAt === undefined || terminalSent) return;
      emit(cancelled ? "cancelled" : "failed", {
        endedAt: now(),
        error:
          cause instanceof Error ? cause.message : "Codex model turn failed",
      });
    },
  };
}
