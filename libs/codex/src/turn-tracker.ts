import { InteractionRequiredError } from "@seqlane/core";
import type { AgentActivity, AgentAdapterRequest } from "@seqlane/agent-adapter";
import { CodexAdapterError } from "./errors.js";
import {
  CodexActivityReducer,
  MAX_TURN_ITEM_BYTES,
  MAX_TURN_ITEMS,
  MAX_TURN_ITEMS_BYTES,
} from "./activity.js";
import {
  type SessionEvent,
  type TurnStartRegistration,
  type TurnEventSubscription,
} from "./session-events.js";
import {
  parseTurnStartResult,
  type CodexTokenUsage,
} from "./index-internal.js";
import { unsupportedCodexServerRequest } from "./protocol.js";
import type { CodexTransport } from "./transport.js";

export interface CompletedTurn {
  readonly turn: ReturnType<typeof parseTurnStartResult>;
  readonly items: readonly Record<string, unknown>[];
  readonly usage?: CodexTokenUsage;
  readonly agentMessageText?: string;
}

export interface TurnTracker {
  readonly completion: Promise<CompletedTurn>;
  readonly interaction: Promise<never>;
  readonly failure: Promise<never>;
  dispose(): void;
}

interface AgentMessageState {
  text: string;
  bytes: number;
  completedText?: string;
}

function itemText(item: Record<string, unknown>): string | undefined {
  if (item.type !== "agentMessage") return undefined;
  if (typeof item.text === "string") return item.text;
  const content = item.content;
  if (!Array.isArray(content)) return undefined;
  return content
    .filter(
      (part): part is { readonly type: "text"; readonly text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as Record<string, unknown>).type === "text" &&
        typeof (part as Record<string, unknown>).text === "string",
    )
    .map((part) => part.text)
    .join("");
}

export { itemText };

function boundedJsonBytes(value: unknown, description: string): number {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("value is not serializable");
    return Buffer.byteLength(serialized, "utf8");
  } catch (cause) {
    throw new CodexAdapterError(
      "limit",
      `Codex ${description} could not be bounded`,
      cause,
    );
  }
}

function isInteraction(method: string): boolean {
  return (
    method.includes("requestApproval") ||
    method.includes("requestUserInput") ||
    method.endsWith("/approval") ||
    method.endsWith("/userInput")
  );
}

export function createTurnTracker(
  registration: TurnStartRegistration,
  turnId: string,
  onActivity: AgentAdapterRequest["onActivity"],
  respond: CodexTransport["respond"],
): TurnTracker {
  const items: Record<string, unknown>[] = [];
  let itemBytes = 0;
  let agentMessageBytes = 0;
  let usage: CodexTokenUsage | undefined;
  let resolveCompletion!: (value: CompletedTurn) => void;
  let rejectCompletion!: (cause: unknown) => void;
  let rejectInteraction!: (cause: unknown) => void;
  let rejectFailure!: (cause: unknown) => void;
  let settled = false;
  const agentMessages = new Map<string, AgentMessageState>();
  const completedAgentMessageIds: string[] = [];
  const completion = new Promise<CompletedTurn>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const interaction = new Promise<never>((_, reject) => {
    rejectInteraction = reject;
  });
  const failure = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });
  const reducer = new CodexActivityReducer((activity: AgentActivity) => {
    try {
      onActivity?.(activity);
    } catch {
      // Activity callbacks are observational and must not stop the turn.
    }
  });
  const addItem = (item: Record<string, unknown>): void => {
    if (items.length >= MAX_TURN_ITEMS) {
      throw new CodexAdapterError(
        "limit",
        `Codex turn exceeded ${MAX_TURN_ITEMS} items`,
      );
    }
    const bytes = boundedJsonBytes(item, "turn item");
    if (
      bytes > MAX_TURN_ITEM_BYTES ||
      itemBytes + bytes > MAX_TURN_ITEMS_BYTES
    ) {
      throw new CodexAdapterError("limit", "Codex turn item limit exceeded");
    }
    itemBytes += bytes;
    items.push(item);
  };
  const addMessageDelta = (itemId: string, delta: string): void => {
    const bytes = Buffer.byteLength(delta, "utf8");
    const state = agentMessages.get(itemId) ?? { text: "", bytes: 0 };
    if (agentMessages.size >= MAX_TURN_ITEMS && !agentMessages.has(itemId)) {
      throw new CodexAdapterError(
        "limit",
        `Codex turn exceeded ${MAX_TURN_ITEMS} agent messages`,
      );
    }
    if (
      bytes > MAX_TURN_ITEM_BYTES ||
      state.bytes + bytes > MAX_TURN_ITEM_BYTES ||
      agentMessageBytes + bytes > MAX_TURN_ITEMS_BYTES
    ) {
      throw new CodexAdapterError(
        "limit",
        "Codex agent message limit exceeded",
      );
    }
    agentMessages.set(itemId, {
      ...state,
      text: state.text + delta,
      bytes: state.bytes + bytes,
    });
    agentMessageBytes += bytes;
  };
  const completeAgentMessage = (item: Record<string, unknown>): void => {
    if (item.type !== "agentMessage" || typeof item.id !== "string") return;
    const state = agentMessages.get(item.id) ?? { text: "", bytes: 0 };
    const text = itemText(item);
    const completedText = text ?? (state.text.length === 0 ? undefined : state.text);
    agentMessages.set(item.id, { ...state, ...(completedText === undefined ? {} : { completedText }) });
    completedAgentMessageIds.push(item.id);
  };
  const selectAgentMessage = (
    completedItems: readonly Record<string, unknown>[],
  ): string | undefined => {
    for (const item of completedItems) completeAgentMessage(item);
    for (const itemId of [...completedAgentMessageIds].reverse()) {
      const text = agentMessages.get(itemId)?.completedText;
      if (text !== undefined) return text;
    }
    return undefined;
  };
  const onMessage = (message: SessionEvent): void => {
    if (settled) return;
    try {
      if (message.kind === "server-request") {
        respond(
          message.request.id,
          unsupportedCodexServerRequest(message.request),
        );
        if (isInteraction(message.request.method)) {
          rejectInteraction(new InteractionRequiredError("user-input"));
        } else {
          rejectFailure(
            new CodexAdapterError(
              "protocol",
              `unsupported Codex server request "${message.request.method}"`,
            ),
          );
        }
        return;
      }
      const notification = message.notification;
      const params = notification.params as Record<string, unknown>;
      if (notification.method === "item/started") {
        reducer.started(
          params.item as Record<string, unknown>,
          params.startedAtMs as number | undefined,
        );
        return;
      }
      if (notification.method === "item/completed") {
        const item = params.item as Record<string, unknown>;
        addItem(item);
        reducer.completed(item, params.completedAtMs as number | undefined);
        completeAgentMessage(item);
        return;
      }
      if (notification.method === "item/agentMessage/delta") {
        const itemId = params.itemId as string;
        const delta = params.delta as string;
        addMessageDelta(itemId, delta);
        reducer.delta(itemId, delta);
        return;
      }
      if (notification.method === "thread/tokenUsage/updated") {
        usage = params.tokenUsage as CodexTokenUsage;
        return;
      }
      if (isInteraction(notification.method)) {
        rejectInteraction(new InteractionRequiredError("user-input"));
        return;
      }
      if (notification.method === "turn/completed") {
        settled = true;
        const completedTurn = params.turn as ReturnType<
          typeof parseTurnStartResult
        >;
        for (const item of completedTurn.items) {
          if (!items.some((existing) => existing.id === item.id)) addItem(item);
        }
        const completedAgentMessageText = selectAgentMessage(completedTurn.items);
        resolveCompletion({
          turn: completedTurn,
          items,
          usage,
          ...(completedAgentMessageText === undefined
            ? {}
            : { agentMessageText: completedAgentMessageText }),
        });
      }
    } catch (cause) {
      rejectFailure(cause);
    }
  };
  const subscription: TurnEventSubscription = registration.bind(
    turnId,
    onMessage,
  );
  return {
    completion,
    interaction,
    failure,
    dispose() {
      subscription.dispose();
      if (!settled) {
        settled = true;
        rejectCompletion(
          new CodexAdapterError("protocol", "turn ended without completion"),
        );
      }
    },
  };
}
