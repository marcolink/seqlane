import { isDeepStrictEqual } from "node:util";
import type {
  AgentActivity,
  AgentAdapterRequest,
} from "@seqlane/agent-adapter";
import { redactOpaqueValue } from "@seqlane/agent-adapter";
import {
  jsonValueSchema,
  type JsonValue,
  type SeqlaneInvocationMetrics,
} from "@seqlane/core";
import type { NativeAssistant, NativeMessage, NativeTool } from "./schemas.js";
import { OpenCodeV2Error } from "./errors.js";

function assertSafePropertyNames(
  value: unknown,
  redact: (text: string) => string,
): void {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current !== "object" || current === null) continue;
    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(current),
    )) {
      if (redact(key) !== key)
        throw new OpenCodeV2Error(
          "protocol",
          "native observation contains a credential in a property name",
        );
      if ("value" in descriptor) pending.push(descriptor.value);
    }
  }
}

/** One reducer feeds both activity and usage; repeated snapshots are deduplicated. */
export function createObserver(
  request: AgentAdapterRequest,
  redact: (text: string) => string = (text) => text,
) {
  const tools = new Map<string, NativeTool>();
  const activeTools = new Map<string, AgentActivity>();
  const terminalTools = new Set<string>();
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
  function assistant(message: NativeAssistant, content: JsonValue): void {
    for (const tool of message.content) {
      if (tool.type !== "tool" || terminalTools.has(tool.id)) continue;
      const previous = tools.get(tool.id);
      if (isDeepStrictEqual(previous, tool)) continue;
      tools.set(tool.id, tool);
      const name = redact(tool.name);
      const activity = {
        activityId: tool.id,
        kind: tool.name === "skill" ? ("skill" as const) : ("tool" as const),
        name,
        startedAt: tool.time.created,
        ...(tool.state.input === undefined
          ? {}
          : { input: redactOpaqueValue(tool.state.input, redact) }),
        ...(tool.state.content === undefined
          ? {}
          : { output: redactOpaqueValue(tool.state.content, redact) }),
        ...(tool.state.metadata === undefined
          ? {}
          : { metadata: redactOpaqueValue(tool.state.metadata, redact) }),
      };
      if (previous === undefined) {
        activeTools.set(tool.id, { ...activity, state: "started" });
        notify(() => request.onActivity?.({ ...activity, state: "started" }));
      }
      if (tool.state.status === "completed" || tool.state.status === "error") {
        terminalTools.add(tool.id);
        tools.delete(tool.id);
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
      } else {
        activeTools.set(tool.id, { ...activity, state: "progress" });
        if (previous !== undefined)
          notify(() =>
            request.onActivity?.({
              activityId: activity.activityId,
              kind: activity.kind,
              name: activity.name,
              startedAt: activity.startedAt,
              state: "progress",
              message: "Tool details updated",
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
            content,
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
      // Reject the whole batch before either callback can expose a credential in a key.
      for (const message of messages)
        if (message.type === "assistant")
          assertSafePropertyNames(message.content, redact);
      const prepared = messages.flatMap((message) => {
        if (message.type !== "assistant") return [];
        const content = jsonValueSchema.safeParse(
          redactOpaqueValue(message.content, redact),
        );
        if (!content.success)
          throw new OpenCodeV2Error(
            "protocol",
            "native observation contains invalid JSON data",
            content.error,
          );
        return [{ message, content: content.data }];
      });
      for (const { message, content } of prepared) assistant(message, content);
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
      tools.clear();
      if (models.size > 0) notify(() => request.onMetrics?.(metrics));
    },
  };
}
