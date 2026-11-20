import type {
  AgentActivity,
  AgentAdapterRequest,
} from "@seqlane/agent-adapter";
import type { SeqlaneInvocationMetrics } from "@seqlane/core";
import type { NativeAssistant, NativeMessage } from "./schemas.js";

/** One reducer feeds both activity and usage; repeated snapshots are deduplicated. */
export function createObserver(
  request: AgentAdapterRequest,
  redact: (text: string) => string = (text) => text,
) {
  const tools = new Map<string, string>();
  const activeTools = new Map<string, AgentActivity>();
  const models = new Set<string>();
  let finished = false;
  let metrics: SeqlaneInvocationMetrics = {};
  const notify = (callback: () => void): void => {
    try {
      callback();
    } catch {
      /* Consumer failures must not replay native work. */
    }
  };
  function assistant(message: NativeAssistant): void {
    for (const tool of message.content) {
      if (tool.type !== "tool" || tools.get(tool.id) === tool.state.status)
        continue;
      const previous = tools.get(tool.id);
      tools.set(tool.id, tool.state.status);
      const name = redact(tool.name);
      const activity = {
        activityId: tool.id,
        kind: tool.name === "skill" ? ("skill" as const) : ("tool" as const),
        name,
        startedAt: tool.time.created,
      };
      if (previous === undefined) {
        activeTools.set(tool.id, { ...activity, state: "started" });
        notify(() => request.onActivity?.({ ...activity, state: "started" }));
      }
      if (tool.state.status === "completed" || tool.state.status === "error") {
        activeTools.delete(tool.id);
        notify(() =>
          request.onActivity?.({
            ...activity,
            state: tool.state.status === "completed" ? "succeeded" : "failed",
            ...(tool.time.completed === undefined
              ? {}
              : { endedAt: tool.time.completed }),
          }),
        );
      }
    }
    if (message.time.completed === undefined || models.has(message.id)) return;
    models.add(message.id);
    const tokens = message.tokens;
    metrics = {
      ...metrics,
      provider: redact(message.model.providerID),
      model: redact(message.model.id),
      ...(message.cost === undefined
        ? {}
        : { cost: (metrics.cost ?? 0) + message.cost }),
      ...(tokens === undefined
        ? {}
        : {
            tokens: {
              input: (metrics.tokens?.input ?? 0) + tokens.input,
              output: (metrics.tokens?.output ?? 0) + tokens.output,
              reasoning: (metrics.tokens?.reasoning ?? 0) + tokens.reasoning,
              cacheRead: (metrics.tokens?.cacheRead ?? 0) + tokens.cache.read,
              cacheWrite:
                (metrics.tokens?.cacheWrite ?? 0) + tokens.cache.write,
            },
          }),
    };
    notify(() =>
      request.onObservation?.({
        observationId: `${request.invocationId}:${message.id}`,
        kind: "model",
        state: message.error === undefined ? "succeeded" : "failed",
        attemptIndex: 0,
        model: {
          operation: "agent",
          provider: redact(message.model.providerID),
          model: redact(message.model.id),
          responseId: message.id,
          startedAt: message.time.created,
          endedAt: message.time.completed,
          ...(message.cost === undefined ? {} : { cost: message.cost }),
          ...(message.tokens === undefined ? {} : { usage: message.tokens }),
          response: {
            text: message.content
              .filter((part) => part.type === "text")
              .map((part) => redact(part.text))
              .join("\n"),
          },
        },
      }),
    );
  }
  return {
    observe(messages: readonly NativeMessage[]) {
      if (finished) return;
      for (const message of messages)
        if (message.type === "assistant") assistant(message);
    },
    finish() {
      if (finished) return;
      finished = true;
      for (const activity of activeTools.values())
        notify(() =>
          request.onActivity?.({
            ...activity,
            state: "failed",
            message: request.signal.aborted
              ? "Tool activity cancelled"
              : "Tool observation ended before completion",
          }),
        );
      activeTools.clear();
      if (models.size > 0) notify(() => request.onMetrics?.(metrics));
    },
  };
}
