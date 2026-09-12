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
  type CodexNotification,
  type CodexTokenUsage,
  type CodexTransport,
} from "./index-internal.js";
import { createCodexStdioTransport } from "./transport.js";

const TURN_TIMEOUT_MS = 30_000;

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
}

interface TurnTracker {
  readonly completion: Promise<CompletedTurn>;
  readonly interaction: Promise<never>;
  dispose(): void;
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

function activityFromItem(
  item: Record<string, unknown>,
): AgentActivity | undefined {
  const id = typeof item.id === "string" ? item.id : undefined;
  const type = typeof item.type === "string" ? item.type : undefined;
  if (id === undefined || type === undefined || type === "agentMessage") {
    return undefined;
  }
  const status = item.status;
  const state: AgentActivity["state"] =
    status === "failed" || item.error !== undefined ? "failed" : "succeeded";
  return {
    activityId: id,
    kind: "tool",
    name: type,
    state,
    ...(item.input === undefined ? {} : { input: item.input }),
    ...(item.output === undefined ? {} : { output: item.output }),
    ...(typeof item.startedAtMs === "number"
      ? { startedAt: item.startedAtMs }
      : {}),
    ...(typeof item.completedAtMs === "number"
      ? { endedAt: item.completedAtMs }
      : {}),
  };
}

type ItemCompletedParams = {
  readonly threadId: string;
  readonly turnId: string;
  readonly item: Record<string, unknown>;
};

type TokenUsageUpdatedParams = {
  readonly threadId: string;
  readonly turnId: string;
  readonly tokenUsage: CodexTokenUsage;
};

type TurnCompletedParams = {
  readonly threadId: string;
  readonly turn: ReturnType<typeof parseTurnStartResult>;
};

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
  transport: CodexTransport,
  threadId: string,
  turnId: string,
): TurnTracker {
  const items: Record<string, unknown>[] = [];
  let usage: CodexTokenUsage | undefined;
  let resolveCompletion!: (value: CompletedTurn) => void;
  let rejectCompletion!: (cause: unknown) => void;
  let rejectInteraction!: (cause: unknown) => void;
  let settled = false;
  const completion = new Promise<CompletedTurn>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const interaction = new Promise<never>((_, reject) => {
    rejectInteraction = reject;
  });
  const unsubscribe = transport.subscribe((message: CodexInboundMessage) => {
    if (message.kind === "server-request") {
      if (
        message.request.method.includes("requestApproval") ||
        message.request.method.includes("requestUserInput")
      ) {
        rejectInteraction(new InteractionRequiredError("user-input"));
      }
      return;
    }
    if (message.kind !== "notification") return;
    const notification = message.notification as CodexNotification;
    if (
      notification.method === "item/completed" &&
      (notification.params as ItemCompletedParams).threadId === threadId &&
      (notification.params as ItemCompletedParams).turnId === turnId
    ) {
      items.push((notification.params as ItemCompletedParams).item);
      return;
    }
    if (
      notification.method === "thread/tokenUsage/updated" &&
      (notification.params as TokenUsageUpdatedParams).threadId === threadId &&
      (notification.params as TokenUsageUpdatedParams).turnId === turnId
    ) {
      usage = (notification.params as TokenUsageUpdatedParams).tokenUsage;
      return;
    }
    if (isInteraction(notification.method)) {
      rejectInteraction(new InteractionRequiredError("user-input"));
      return;
    }
    if (
      notification.method === "turn/completed" &&
      (notification.params as TurnCompletedParams).threadId === threadId &&
      (notification.params as TurnCompletedParams).turn.id === turnId &&
      !settled
    ) {
      settled = true;
      const completedTurn = (notification.params as TurnCompletedParams).turn;
      resolveCompletion({
        turn: completedTurn,
        items: items.length > 0 ? items : completedTurn.items,
        usage,
      });
    }
  });
  return {
    completion,
    interaction,
    dispose() {
      unsubscribe();
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

function createAdapterForTransport(
  transport: CodexTransport,
  configuration: CodexLaunchConfiguration,
  options: CodexAdapterOptions,
  initialThreadId?: string,
): AgentAdapter {
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
      await transport.request("turn/interrupt", { threadId, turnId: id });
      await withTimeout(tracker.completion, TURN_TIMEOUT_MS);
    } catch (cause) {
      invalidated = true;
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
      const trackerPromise = transport.request(
        "turn/start",
        {
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
        },
        signal,
      );
      const turn = parseTurnStartResult(await trackerPromise);
      const tracker = createTurnTracker(transport, id, turn.id);
      if (!backgroundProcessReported) {
        backgroundProcessReported = true;
        request.onBackgroundProcess?.({
          mutatesWorkspace: true,
          termination: transport.termination,
        });
      }
      try {
        let removeAbortListener = (): void => undefined;
        const abort = new Promise<never>((_, reject) => {
          const onAbort = () => {
            reject(
              signal.reason ??
                new CodexAdapterError(
                  "cancellation",
                  "Codex task was cancelled",
                ),
            );
          };
          if (signal.aborted) onAbort();
          else {
            signal.addEventListener("abort", onAbort, { once: true });
            removeAbortListener = () =>
              signal.removeEventListener("abort", onAbort);
          }
        });
        let completed: CompletedTurn;
        try {
          completed = await Promise.race([
            tracker.completion,
            tracker.interaction,
            abort,
          ]);
        } catch (cause) {
          if (cause instanceof InteractionRequiredError || signal.aborted) {
            await interruptAndConfirm(turn.id, tracker, request);
          }
          throw cause;
        } finally {
          removeAbortListener();
        }
        if (completed.turn.status !== "completed") {
          throw new CodexAdapterError(
            "execution",
            `Codex turn ended with status ${completed.turn.status}`,
          );
        }
        lastTurnId = completed.turn.id;
        for (const item of completed.items) {
          const activity = activityFromItem(item);
          if (activity !== undefined) request.onActivity?.(activity);
        }
        const text = [...completed.items]
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
