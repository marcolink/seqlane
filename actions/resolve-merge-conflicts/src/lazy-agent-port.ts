import type {
  AgentRunnerPort,
  AgentResolutionRequest,
} from "@seqlane/action-merge-conflict-resolution";

export function createLazyAgentPort(
  factory: () => AgentRunnerPort,
): AgentRunnerPort {
  let runner: AgentRunnerPort | undefined;
  let started = false;
  let stopped = true;
  let stopping: Promise<void> | undefined;

  const getRunner = (): AgentRunnerPort => {
    runner ??= factory();
    return runner;
  };

  return {
    start: async () => {
      if (started) return;
      const current = getRunner();
      try {
        await current.start?.();
        started = true;
        stopped = false;
      } catch (error: unknown) {
        await current.stop?.().catch(() => undefined);
        throw error;
      }
    },
    resolve: async (request: AgentResolutionRequest) => {
      await getRunner().resolve(request);
    },
    stop: async () => {
      const current = runner;
      if (current === undefined || stopped) return;
      if (stopping !== undefined) return stopping;

      stopping = (async () => {
        try {
          await current.stop?.();
          stopped = true;
          started = false;
        } finally {
          stopping = undefined;
        }
      })();
      return stopping;
    },
  };
}
