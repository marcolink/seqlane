import { randomUUID } from "node:crypto";
import { InteractionRequiredError } from "@seqlane/core";
import type {
  AgentActivity,
  AgentAdapter,
  AgentAdapterRequest,
  AgentDiagnostic,
} from "@seqlane/agent-adapter";
import type { ModelSelection, SeqlaneInvocationMetrics } from "@seqlane/core";
import { z } from "zod";
import { CodexAdapterError, CodexStructuredOutputError } from "./errors.js";
import {
  parseCodexLaunchConfiguration,
  parseModelListResult,
  parseThreadResult,
  parseTurnStartResult,
  type CodexInboundMessage,
  type CodexLaunchConfiguration,
  type CodexTokenUsage,
  type CodexTransport,
} from "./index-internal.js";
import { createCodexStdioTransport } from "./transport.js";

const TURN_TIMEOUT_MS = 30_000;
const TURN_START_CONFIRM_TIMEOUT_MS = 5_000;
const TURN_INTERRUPT_REQUEST_TIMEOUT_MS = 5_000;
const MAX_TURN_ITEMS = 1_024;
const MAX_TURN_ITEM_BYTES = 1_000_000;
const MAX_TURN_ITEMS_BYTES = 8_000_000;
const MAX_BUFFERED_TURN_EVENTS = 2_048;
const MAX_BUFFERED_TURN_EVENT_BYTES = 8_000_000;

export interface CodexAdapterOptions {
  readonly signal?: AbortSignal;
  readonly modelSelection?: ModelSelection;
  readonly createTransport?: (
    configuration: CodexLaunchConfiguration,
    options: {
      readonly onDiagnostic?: (diagnostic: AgentDiagnostic) => void;
    },
  ) => Promise<CodexTransport>;
}

interface Checkpoint {
  readonly kind: "codex-checkpoint";
  readonly binding: string;
  readonly threadId: string;
  readonly turnId: string;
}

interface CompletedTurn {
  readonly turn: ReturnType<typeof parseTurnStartResult>;
  readonly items: readonly Record<string, unknown>[];
  readonly usage?: CodexTokenUsage;
  readonly agentMessageText?: string;
}

interface TurnTracker {
  readonly completion: Promise<CompletedTurn>;
  readonly interaction: Promise<never>;
  readonly failure: Promise<never>;
  dispose(): void;
}

type SessionEvent = Exclude<CodexInboundMessage, { kind: "response" }>;
type SessionEventListener = (message: SessionEvent) => void;

interface TurnStartRegistration {
  bind(turnId: string, listener: SessionEventListener): TurnEventSubscription;
  cancel(): void;
}

interface TurnEventSubscription {
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

class CodexSessionEventDispatcher {
  private readonly starts = new Set<{
    readonly threadId: string;
    readonly events: SessionEvent[];
    eventBytes: number;
  }>();
  private readonly active = new Map<string, SessionEventListener>();

  constructor(transport: CodexTransport) {
    transport.subscribe((message) => {
      if (message.kind !== "response") this.dispatch(message);
    });
  }

  begin(threadId: string): TurnStartRegistration {
    const state = { threadId, events: [], eventBytes: 0 };
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
    if (correlation.threadId === undefined) return;
    for (const state of this.starts) {
      if (state.threadId !== correlation.threadId) continue;
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
}

const sessionDispatchers = new WeakMap<
  CodexTransport,
  CodexSessionEventDispatcher
>();

function sessionDispatcher(
  transport: CodexTransport,
): CodexSessionEventDispatcher {
  const existing = sessionDispatchers.get(transport);
  if (existing !== undefined) return existing;
  const created = new CodexSessionEventDispatcher(transport);
  sessionDispatchers.set(transport, created);
  return created;
}

function reportDiagnostic(
  request: AgentAdapterRequest,
  diagnostic: AgentDiagnostic,
): void {
  try {
    request.onDiagnostic?.(diagnostic);
  } catch {
    // Diagnostics are best effort.
  }
}

function composeSignals(
  runtimeSignal: AbortSignal | undefined,
  invocationSignal: AbortSignal,
): AbortSignal {
  if (runtimeSignal === undefined || runtimeSignal === invocationSignal) {
    return invocationSignal;
  }
  return AbortSignal.any([runtimeSignal, invocationSignal]);
}

function buildPrompt(request: AgentAdapterRequest): string {
  const input = JSON.stringify(request.input);
  const instructions = request.agent?.instructions?.map(
    (value) => `Instruction: ${value}`,
  );
  const references = request.agent?.references?.map(
    (value) => `Reference: ${value}`,
  );
  return [
    request.agent?.goal ?? `Complete task ${request.task.id}`,
    ...(instructions ?? []),
    ...(references ?? []),
    `Task input JSON: ${input}`,
    "Return only the JSON value required by the task output schema.",
  ].join("\n");
}

function taskJsonSchema(
  task: AgentAdapterRequest["task"],
): Record<string, unknown> {
  try {
    return z.toJSONSchema(task.output) as Record<string, unknown>;
  } catch (cause) {
    throw new CodexStructuredOutputError(
      `task "${task.id}" output schema cannot produce JSON Schema`,
      cause,
    );
  }
}

function modelParams(selection: ModelSelection | undefined): {
  readonly model?: string;
  readonly effort?: string;
} {
  if (selection === undefined) return {};
  if (selection.model.provider !== "openai") {
    throw new CodexAdapterError(
      "configuration",
      `provider "${selection.model.provider}" is not supported by Codex`,
    );
  }
  return {
    model: selection.model.model,
    ...(selection.reasoning === undefined
      ? {}
      : { effort: selection.reasoning }),
  };
}

function isInteraction(method: string): boolean {
  return (
    method.includes("requestApproval") ||
    method.includes("requestUserInput") ||
    method.endsWith("/approval") ||
    method.endsWith("/userInput")
  );
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

interface ActivityRecord {
  readonly activityId: string;
  readonly name: string;
  readonly input?: unknown;
  readonly startedAt?: number;
}

class CodexActivityReducer {
  private readonly records = new Map<string, ActivityRecord>();

  constructor(private readonly emit: (activity: AgentActivity) => void) {}

  started(item: Record<string, unknown>, startedAt?: number): void {
    const record = this.record(item, startedAt);
    if (record === undefined) return;
    this.records.set(record.activityId, record);
    this.emit({ ...record, kind: "tool", state: "started" });
  }

  delta(itemId: string, delta: string): void {
    const record =
      this.records.get(itemId) ??
      ({ activityId: itemId, name: "agentMessage" } satisfies ActivityRecord);
    this.emit({
      activityId: record.activityId,
      kind: "tool",
      name: record.name,
      state: "progress",
      message: delta,
    });
  }

  completed(item: Record<string, unknown>, completedAt?: number): void {
    const record = this.record(item);
    if (record === undefined) return;
    this.records.set(record.activityId, record);
    const failed = item.status === "failed" || item.error !== undefined;
    this.emit({
      ...record,
      kind: "tool",
      state: failed ? "failed" : "succeeded",
      ...(item.output === undefined ? {} : { output: item.output }),
      ...(completedAt === undefined ? {} : { endedAt: completedAt }),
      ...(failed ? { message: "Tool failed" } : {}),
    });
  }

  private record(
    item: Record<string, unknown>,
    startedAt?: number,
  ): ActivityRecord | undefined {
    const activityId = typeof item.id === "string" ? item.id : undefined;
    const name = typeof item.type === "string" ? item.type : undefined;
    if (
      activityId === undefined ||
      name === undefined ||
      name === "agentMessage"
    ) {
      return undefined;
    }
    return {
      activityId,
      name,
      ...(item.input === undefined ? {} : { input: item.input }),
      ...(startedAt === undefined ? {} : { startedAt }),
    };
  }
}

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

function metricsFromUsage(
  usage: CodexTokenUsage | undefined,
  selection: ModelSelection | undefined,
  durationMs: number,
): SeqlaneInvocationMetrics | undefined {
  if (usage === undefined && selection === undefined) return undefined;
  const last = usage?.last;
  return {
    durationMs,
    ...(selection === undefined ? {} : { modelSelection: selection }),
    ...(selection === undefined ? {} : { provider: selection.model.provider }),
    ...(selection === undefined ? {} : { model: selection.model.model }),
    ...(last === undefined
      ? {}
      : {
          tokens: {
            total: last.totalTokens,
            input: last.inputTokens,
            output: last.outputTokens,
            reasoning: last.reasoningOutputTokens,
            cacheRead: last.cachedInputTokens,
            cacheWrite: last.cacheWriteInputTokens,
          },
        }),
  };
}

function createTurnTracker(
  registration: TurnStartRegistration,
  turnId: string,
  onActivity: ((activity: AgentActivity) => void) | undefined,
): TurnTracker {
  const items: Record<string, unknown>[] = [];
  let itemBytes = 0;
  let usage: CodexTokenUsage | undefined;
  let agentMessageText = "";
  let agentMessageTextBytes = 0;
  let resolveCompletion!: (value: CompletedTurn) => void;
  let rejectCompletion!: (cause: unknown) => void;
  let rejectInteraction!: (cause: unknown) => void;
  let rejectFailure!: (cause: unknown) => void;
  let settled = false;
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
  const reducer = new CodexActivityReducer((activity) => {
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
  const addMessageDelta = (delta: string): void => {
    const bytes = Buffer.byteLength(delta, "utf8");
    if (
      bytes > MAX_TURN_ITEM_BYTES ||
      agentMessageTextBytes + bytes > MAX_TURN_ITEMS_BYTES
    ) {
      throw new CodexAdapterError(
        "limit",
        "Codex agent message limit exceeded",
      );
    }
    agentMessageTextBytes += bytes;
    agentMessageText += delta;
  };
  const onMessage = (message: SessionEvent): void => {
    if (settled) return;
    try {
      if (message.kind === "server-request") {
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
        return;
      }
      if (notification.method === "item/agentMessage/delta") {
        const delta = params.delta as string;
        addMessageDelta(delta);
        reducer.delta(params.itemId as string, delta);
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
        resolveCompletion({
          turn: completedTurn,
          items,
          usage,
          ...(agentMessageText.length === 0 ? {} : { agentMessageText }),
        });
      }
    } catch (cause) {
      rejectFailure(cause);
    }
  };
  const subscription = registration.bind(turnId, onMessage);
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

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new CodexAdapterError(
                "cancellation",
                "Codex turn termination was not confirmed",
              ),
            ),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    throw (
      signal.reason ??
      new CodexAdapterError("cancellation", "Codex task was cancelled")
    );
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(
        signal.reason ??
          new CodexAdapterError("cancellation", "Codex task was cancelled"),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (cause) => {
        signal.removeEventListener("abort", onAbort);
        reject(cause);
      },
    );
  });
}

function createAdapterForTransport(
  transport: CodexTransport,
  configuration: CodexLaunchConfiguration,
  options: CodexAdapterOptions,
  initialThreadId?: string,
): AgentAdapter {
  const dispatcher = sessionDispatcher(transport);
  const binding = randomUUID();
  let threadId = initialThreadId;
  let lastTurnId: string | undefined;
  let invalidated = false;
  let threadPromise: Promise<string> | undefined;
  let queue = Promise.resolve();
  let selectionResolved = false;
  let effectiveSelection: ModelSelection | undefined;
  let backgroundProcessReported = false;

  const selectionFor = (
    request: AgentAdapterRequest,
  ): ModelSelection | undefined =>
    request.modelSelection ?? options.modelSelection;

  const resolveSelection = async (
    requested: ModelSelection | undefined,
    signal: AbortSignal,
  ): Promise<ModelSelection | undefined> => {
    if (selectionResolved) {
      if (
        requested !== undefined &&
        JSON.stringify(requested) !== JSON.stringify(effectiveSelection)
      ) {
        throw new CodexAdapterError(
          "configuration",
          "Codex session model selection is already pinned",
        );
      }
      return effectiveSelection;
    }
    modelParams(requested);
    const models = parseModelListResult(
      await transport.request("model/list", {}, signal),
    );
    const selected =
      requested === undefined
        ? models.find((model) => model.isDefault)
        : models.find((model) => model.model === requested.model.model);
    if (requested !== undefined && selected === undefined) {
      throw new CodexAdapterError(
        "configuration",
        `Codex model "${requested.model.model}" is not available`,
      );
    }
    if (
      requested !== undefined &&
      requested.reasoning !== undefined &&
      selected !== undefined &&
      !selected.supportedReasoningEfforts.includes(requested.reasoning)
    ) {
      throw new CodexAdapterError(
        "configuration",
        `Codex model "${requested.model.model}" does not support reasoning effort "${requested.reasoning}"`,
      );
    }
    effectiveSelection =
      requested ??
      (selected === undefined
        ? undefined
        : { model: { provider: "openai", model: selected.model } });
    if (
      requested?.reasoning !== undefined &&
      effectiveSelection !== undefined
    ) {
      effectiveSelection = {
        ...effectiveSelection,
        reasoning: requested.reasoning,
      };
    }
    selectionResolved = true;
    return effectiveSelection;
  };

  const ensureThread = async (
    signal: AbortSignal,
    selection: ModelSelection | undefined,
  ): Promise<string> => {
    if (invalidated)
      throw new CodexAdapterError("execution", "Codex session is invalidated");
    if (threadId !== undefined) return threadId;
    return (threadPromise ??= (async () => {
      const params = {
        cwd: configuration.workspace,
        approvalPolicy: "never",
        sandbox: "workspaceWrite",
        ...(selection === undefined ? {} : modelParams(selection)),
      };
      const result = await transport.request("thread/start", params, signal);
      threadId = parseThreadResult(result).id;
      return threadId;
    })());
  };

  const interruptAndConfirm = async (
    id: string,
    tracker: TurnTracker,
    request: AgentAdapterRequest,
  ): Promise<void> => {
    try {
      await withTimeout(
        transport.request("turn/interrupt", { threadId, turnId: id }),
        TURN_INTERRUPT_REQUEST_TIMEOUT_MS,
      );
      await withTimeout(tracker.completion, TURN_TIMEOUT_MS);
    } catch (cause) {
      invalidated = true;
      await transport.close().catch(() => undefined);
      request.onUncertainActivity?.({
        reason: "timeout",
        termination: transport.termination,
      });
      throw new CodexAdapterError(
        "cancellation",
        "Codex turn termination was not confirmed",
        cause,
      );
    }
  };

  const execute = async (request: AgentAdapterRequest): Promise<unknown> => {
    const operation = queue.then(async () => {
      const startedAt = Date.now();
      const signal = composeSignals(options.signal, request.signal);
      const requestedSelection = selectionFor(request);
      const selection = await resolveSelection(requestedSelection, signal);
      const model = modelParams(selection);
      const id = await ensureThread(signal, selection);
      const registration = dispatcher.begin(id);
      const turnStartPromise = transport.request("turn/start", {
        threadId: id,
        input: [{ type: "text", text: buildPrompt(request) }],
        cwd: configuration.workspace,
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [configuration.workspace],
          networkAccess: configuration.networkAccess,
        },
        outputSchema: taskJsonSchema(request.task),
        ...(model.model === undefined ? {} : model),
      });
      let turn: ReturnType<typeof parseTurnStartResult>;
      let tracker!: TurnTracker;
      try {
        turn = parseTurnStartResult(
          await raceWithAbort(turnStartPromise, signal),
        );
        tracker = createTurnTracker(registration, turn.id, request.onActivity);
      } catch (cause) {
        if (signal.aborted) {
          try {
            turn = parseTurnStartResult(
              await withTimeout(
                turnStartPromise,
                TURN_START_CONFIRM_TIMEOUT_MS,
              ),
            );
            tracker = createTurnTracker(
              registration,
              turn.id,
              request.onActivity,
            );
            await interruptAndConfirm(turn.id, tracker, request);
          } catch (confirmationCause) {
            registration.cancel();
            invalidated = true;
            await transport.close().catch(() => undefined);
            throw new CodexAdapterError(
              "cancellation",
              "Codex turn start could not be terminated safely",
              confirmationCause,
            );
          } finally {
            tracker?.dispose();
          }
        } else {
          registration.cancel();
        }
        throw cause;
      }
      if (!backgroundProcessReported) {
        backgroundProcessReported = true;
        request.onBackgroundProcess?.({
          mutatesWorkspace: true,
          termination: transport.termination,
        });
      }
      try {
        let completed: CompletedTurn;
        try {
          completed = await raceWithAbort(
            withTimeout(
              Promise.race([
                tracker.completion,
                tracker.interaction,
                tracker.failure,
              ]),
              TURN_TIMEOUT_MS,
            ),
            signal,
          );
        } catch (cause) {
          const shouldInterrupt =
            cause instanceof InteractionRequiredError ||
            signal.aborted ||
            (cause instanceof CodexAdapterError &&
              ["cancellation", "limit", "protocol"].includes(cause.code));
          if (shouldInterrupt) {
            await interruptAndConfirm(turn.id, tracker, request);
          }
          throw cause;
        }
        if (completed.turn.status !== "completed") {
          throw new CodexAdapterError(
            "execution",
            `Codex turn ended with status ${completed.turn.status}`,
          );
        }
        lastTurnId = completed.turn.id;
        const text =
          completed.agentMessageText ??
          [...completed.items]
            .reverse()
            .map(itemText)
            .find((value) => value !== undefined);
        if (text === undefined)
          throw new CodexStructuredOutputError(
            "Codex turn did not return an agent message",
          );
        let value: unknown;
        try {
          value = JSON.parse(text);
        } catch (cause) {
          throw new CodexStructuredOutputError(
            "Codex agent message was not valid JSON",
            cause,
          );
        }
        const parsed = request.task.output.safeParse(value);
        if (!parsed.success)
          throw new CodexStructuredOutputError(
            "Codex output did not satisfy the task schema",
            parsed.error,
          );
        const metrics = metricsFromUsage(
          completed.usage,
          selection,
          Date.now() - startedAt,
        );
        if (metrics !== undefined) request.onMetrics?.(metrics);
        return parsed.data;
      } finally {
        tracker.dispose();
      }
    });
    queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };

  const adapter: AgentAdapter = {
    capabilities: {
      execute: true,
      modelSelection: true,
      structuredOutput: true,
      sessionReuse: true,
      checkpoint: true,
      fork: true,
      activity: true,
      sessionUi: false,
    },
    execute,
    captureCheckpoint: async () => {
      if (threadId === undefined || lastTurnId === undefined) {
        throw new CodexAdapterError(
          "execution",
          "Codex session has no completed turn checkpoint",
        );
      }
      return {
        kind: "codex-checkpoint",
        binding,
        threadId,
        turnId: lastTurnId,
      } satisfies Checkpoint;
    },
    fork: async ({ checkpoint, modelSelection }) => {
      const parsed = z
        .object({
          kind: z.literal("codex-checkpoint"),
          binding: z.string(),
          threadId: z.string(),
          turnId: z.string(),
        })
        .safeParse(checkpoint);
      if (
        !parsed.success ||
        parsed.data.binding !== binding ||
        parsed.data.threadId !== threadId
      ) {
        throw new CodexAdapterError(
          "configuration",
          "Codex checkpoint does not belong to this session",
        );
      }
      const result = await transport.request("thread/fork", {
        threadId: parsed.data.threadId,
        lastTurnId: parsed.data.turnId,
      });
      const child = parseThreadResult(result);
      return createAdapterForTransport(
        transport,
        configuration,
        {
          ...options,
          modelSelection: modelSelection ?? options.modelSelection,
        },
        child.id,
      );
    },
  };
  return adapter;
}

export function createCodexAdapterForTransport(
  transport: CodexTransport,
  configuration: CodexLaunchConfiguration,
  options: Omit<CodexAdapterOptions, "createTransport"> = {},
): AgentAdapter {
  return createAdapterForTransport(transport, configuration, options);
}

export function createCodexAdapter(
  configuration: CodexLaunchConfiguration,
  options: CodexAdapterOptions = {},
): AgentAdapter {
  const validated = parseCodexLaunchConfiguration(configuration);
  let adapterPromise: Promise<AgentAdapter> | undefined;
  const resolveAdapter = (
    request: AgentAdapterRequest,
  ): Promise<AgentAdapter> =>
    (adapterPromise ??= (options.createTransport ?? createCodexStdioTransport)(
      validated,
      {
        onDiagnostic: (diagnostic) => reportDiagnostic(request, diagnostic),
      },
    ).then((transport) =>
      createAdapterForTransport(transport, validated, options),
    ));
  const lifecycleRequest = (): AgentAdapterRequest =>
    ({
      invocationId: "codex-lifecycle",
      observability: {},
      task: {
        id: "codex-lifecycle",
        input: z.unknown(),
        output: z.unknown(),
        execute: async () => undefined,
      },
      input: undefined,
      signal: options.signal ?? new AbortController().signal,
    }) as AgentAdapterRequest;
  return {
    get capabilities() {
      return {
        execute: true,
        modelSelection: true,
        structuredOutput: true,
        sessionReuse: true,
        checkpoint: true,
        fork: true,
        activity: true,
        sessionUi: false,
      } as const;
    },
    execute: (request) =>
      resolveAdapter(request).then((adapter) => adapter.execute(request)),
    captureCheckpoint: async () => {
      const adapter = await resolveAdapter(lifecycleRequest());
      if (adapter.captureCheckpoint === undefined) {
        throw new CodexAdapterError(
          "configuration",
          "Codex checkpoint is unavailable",
        );
      }
      return adapter.captureCheckpoint();
    },
    fork: async (request) => {
      const adapter = await resolveAdapter(lifecycleRequest());
      if (adapter.fork === undefined) {
        throw new CodexAdapterError(
          "configuration",
          "Codex fork is unavailable",
        );
      }
      return adapter.fork(request);
    },
  };
}
