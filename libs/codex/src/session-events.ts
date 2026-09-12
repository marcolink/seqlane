import { CodexAdapterError } from "./errors.js";
import type { CodexInboundMessage, CodexTransport } from "./index-internal.js";

const MAX_BUFFERED_TURN_EVENTS = 2_048;
const MAX_BUFFERED_TURN_EVENT_BYTES = 8_000_000;

export type SessionEvent = Exclude<CodexInboundMessage, { kind: "response" }>;
export type SessionEventListener = (message: SessionEvent) => void;

export interface TurnStartRegistration {
  bind(turnId: string, listener: SessionEventListener): TurnEventSubscription;
  cancel(): void;
}

export interface TurnEventSubscription {
  dispose(): void;
}

interface EventCorrelation {
  readonly threadId?: string;
  readonly turnId?: string;
}

function recordCorrelation(value: unknown): EventCorrelation {
  if (typeof value !== "object" || value === null) return {};
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.threadId === "string"
      ? { threadId: record.threadId }
      : {}),
    ...(typeof record.turnId === "string" ? { turnId: record.turnId } : {}),
  };
}

function eventCorrelation(message: SessionEvent): EventCorrelation {
  if (message.kind === "server-request") {
    return recordCorrelation(message.request.params);
  }
  const params =
    typeof message.notification.params === "object" &&
    message.notification.params !== null
      ? (message.notification.params as Record<string, unknown>)
      : undefined;
  if (params === undefined) return {};
  if (
    message.notification.method === "turn/started" ||
    message.notification.method === "turn/completed"
  ) {
    const turn =
      typeof params.turn === "object" && params.turn !== null
        ? (params.turn as Record<string, unknown>)
        : undefined;
    return {
      ...(typeof params.threadId === "string"
        ? { threadId: params.threadId }
        : {}),
      ...(typeof turn?.id === "string" ? { turnId: turn.id } : {}),
    };
  }
  return recordCorrelation(params);
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`;
}

interface PendingStart {
  readonly threadId: string;
  readonly events: SessionEvent[];
  eventBytes: number;
}

export class CodexSessionEventDispatcher {
  private readonly starts = new Set<PendingStart>();
  private readonly active = new Map<string, SessionEventListener>();

  constructor(transport: CodexTransport) {
    transport.subscribe((message) => {
      if (message.kind !== "response") this.dispatch(message);
    });
  }

  begin(threadId: string): TurnStartRegistration {
    const state: PendingStart = { threadId, events: [], eventBytes: 0 };
    this.starts.add(state);
    return {
      bind: (turnId, listener) => {
        this.starts.delete(state);
        const key = turnKey(threadId, turnId);
        if (this.active.has(key)) {
          throw new CodexAdapterError(
            "protocol",
            `Codex turn ${turnId} already has an event listener`,
          );
        }
        this.active.set(key, listener);
        try {
          for (const event of state.events) {
            const correlation = eventCorrelation(event);
            if (
              event.kind === "server-request" &&
              correlation.threadId === undefined
            ) {
              listener(event);
              continue;
            }
            if (
              correlation.threadId === threadId &&
              correlation.turnId === turnId
            ) {
              listener(event);
            }
          }
        } catch (cause) {
          this.active.delete(key);
          throw cause;
        }
        return { dispose: () => this.active.delete(key) };
      },
      cancel: () => this.starts.delete(state),
    };
  }

  private dispatch(message: SessionEvent): void {
    const correlation = eventCorrelation(message);
    if (message.kind === "server-request") {
      if (
        correlation.threadId === undefined ||
        correlation.turnId === undefined
      ) {
        throw new CodexAdapterError(
          "protocol",
          "Codex app-server sent an uncorrelated server request",
        );
      }
      const listener = this.active.get(
        turnKey(correlation.threadId, correlation.turnId),
      );
      if (listener !== undefined) {
        listener(message);
        return;
      }
      let buffered = false;
      for (const state of this.starts) {
        if (state.threadId !== correlation.threadId) continue;
        this.buffer(state, message);
        buffered = true;
      }
      if (!buffered) {
        throw new CodexAdapterError(
          "protocol",
          `Codex app-server sent a server request for unknown turn ${correlation.turnId}`,
        );
      }
      return;
    }
    if (
      correlation.threadId !== undefined &&
      correlation.turnId !== undefined
    ) {
      const listener = this.active.get(
        turnKey(correlation.threadId, correlation.turnId),
      );
      if (listener !== undefined) {
        listener(message);
        return;
      }
    }
    if (correlation.threadId === undefined) {
      return;
    }
    for (const state of this.starts) {
      if (state.threadId === correlation.threadId) this.buffer(state, message);
    }
  }

  private buffer(state: PendingStart, message: SessionEvent): void {
    if (state.events.length >= MAX_BUFFERED_TURN_EVENTS) {
      throw new CodexAdapterError(
        "limit",
        `Codex buffered turn events exceeded ${MAX_BUFFERED_TURN_EVENTS}`,
      );
    }
    const bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
    if (state.eventBytes + bytes > MAX_BUFFERED_TURN_EVENT_BYTES) {
      throw new CodexAdapterError(
        "limit",
        `Codex buffered turn events exceeded ${MAX_BUFFERED_TURN_EVENT_BYTES} bytes`,
      );
    }
    state.eventBytes += bytes;
    state.events.push(message);
  }
}

const sessionDispatchers = new WeakMap<
  CodexTransport,
  CodexSessionEventDispatcher
>();

export function sessionDispatcher(
  transport: CodexTransport,
): CodexSessionEventDispatcher {
  const existing = sessionDispatchers.get(transport);
  if (existing !== undefined) return existing;
  const created = new CodexSessionEventDispatcher(transport);
  sessionDispatchers.set(transport, created);
  return created;
}
