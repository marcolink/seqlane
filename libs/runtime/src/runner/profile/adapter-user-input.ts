import type {
  AgentAdapterRequest,
  UserInputAnswer,
} from "@seqlane/agent-adapter";
import type { ExecutorRequest } from "../../runtime/execution/executor.js";
import { UserInputProtocolError } from "../user-input-broker.js";

/** Owns input callbacks until their adapter execution has settled. */
export function createAdapterUserInput(
  requestUserInput: NonNullable<ExecutorRequest["requestUserInput"]>,
  executionSignal: AbortSignal,
) {
  const controller = new AbortController();
  const signal = AbortSignal.any([executionSignal, controller.signal]);
  const pending = new Set<Promise<UserInputAnswer>>();
  const request: NonNullable<AgentAdapterRequest["requestUserInput"]> = async (
    input,
  ) => {
    signal.throwIfAborted();
    const answer = requestUserInput(input, signal);
    pending.add(answer);
    try {
      return await answer;
    } finally {
      pending.delete(answer);
    }
  };

  return {
    request,
    async close(cause?: unknown): Promise<void> {
      controller.abort(
        new UserInputProtocolError("USER_INPUT_PROTOCOL_ERROR", cause),
      );
      // The broker publishes terminal resolutions before rejecting callbacks.
      await Promise.allSettled([...pending]);
    },
  };
}
