import { Effect, Semaphore } from "effect";
import type { AgentAdapter, AgentAdapterRequest } from "@seqlane/agent-adapter";
import {
  type AcpExecutorOptions,
  type AcpLaunchConfiguration,
  parseAcpLaunchConfiguration,
} from "./contracts.js";
import { executeAcpRequest, type AcpExecutionState } from "./execution.js";

export function createAcpAdapter(
  configuration: AcpLaunchConfiguration,
  options: AcpExecutorOptions = {},
): AgentAdapter {
  const validatedConfiguration = parseAcpLaunchConfiguration(configuration);
  const executionSemaphore = Effect.runSync(Semaphore.make(1));
  const retryCount = options.structuredOutputRetryCount ?? 0;
  const state: AcpExecutionState = {
    transport: {
      promise: undefined,
      controller: undefined,
    },
    persistentSession: undefined,
    closePromise: undefined,
  };

  const executeRequest = (request: AgentAdapterRequest): Promise<unknown> =>
    executeAcpRequest(state, validatedConfiguration, retryCount, request);

  const close = (): Promise<void> => {
    if (state.closePromise !== undefined) return state.closePromise;
    state.transport.controller?.abort(new Error("ACP adapter closed"));
    state.closePromise = Effect.runPromise(
      executionSemaphore.withPermits(1)(
        Effect.tryPromise({
          try: async () => {
            const transport =
              state.transport.promise === undefined
                ? undefined
                : await state.transport.promise;
            state.persistentSession?.dispose();
            state.persistentSession = undefined;
            if (transport !== undefined) await transport.close();
          },
          catch: (cause) => cause,
        }),
      ),
    );
    return state.closePromise;
  };

  return {
    execute(request) {
      return Effect.runPromise(
        executionSemaphore.withPermits(1)(
          Effect.tryPromise({
            try: () => executeRequest(request),
            catch: (cause) => cause,
          }),
        ),
      );
    },
    close,
    capabilities: {
      execute: true,
      modelSelection: false,
      structuredOutput: true,
      sessionReuse: validatedConfiguration.persistSession,
      checkpoint: false,
      fork: false,
      activity: true,
      sessionUi: false,
    },
  };
}
