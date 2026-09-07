import type {
  AgentRunnerPort,
  AgentResolutionRequest,
} from "@seqlane/action-merge-conflict-resolution";

export function createLazyAgentPort(
  factory: () => AgentRunnerPort,
): AgentRunnerPort {
  let runner: AgentRunnerPort | undefined;
  let state: "stopped" | "starting" | "started" | "cleanup-required" =
    "stopped";
  let cleanupInFlight: Promise<void> | undefined;

  const getRunner = (): AgentRunnerPort => {
    runner ??= factory();
    return runner;
  };

  return {
    start: async () => {
      if (state === "started") return;
      if (state === "cleanup-required") await cleanup();
      const current = getRunner();
      state = "starting";
      try {
        await current.start?.();
        state = "started";
      } catch (error: unknown) {
        state = "cleanup-required";
        await cleanup().catch(() => undefined);
        throw error;
      }
    },
    resolve: async (request: AgentResolutionRequest) => {
      await getRunner().resolve(request);
    },
    stop: async () => {
      const current = runner;
      if (current === undefined || state === "stopped") return;
      return cleanup();
    },
  };

  async function cleanup(): Promise<void> {
    if (cleanupInFlight !== undefined) return cleanupInFlight;
    const current = runner;
    if (current === undefined || state === "stopped") return;

    cleanupInFlight = (async () => {
      try {
        await current.stop?.();
        state = "stopped";
      } catch (error: unknown) {
        state = "cleanup-required";
        throw error;
      } finally {
        cleanupInFlight = undefined;
      }
    })();
    return cleanupInFlight;
  }
}
