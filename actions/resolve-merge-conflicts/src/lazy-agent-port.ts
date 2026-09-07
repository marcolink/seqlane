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
      stopped = true;
      started = false;
      await current.stop?.();
    },
  };
}
