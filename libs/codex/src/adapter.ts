import { randomUUID } from "node:crypto";
import { InteractionRequiredError } from "@seqlane/core";
import type {
  AgentAdapter,
  AgentAdapterRequest,
  AgentDiagnostic,
} from "@seqlane/agent-adapter";
import type { ModelSelection, SeqlaneInvocationMetrics } from "@seqlane/core";
import { z } from "zod";
import { CodexAdapterError, CodexStructuredOutputError } from "./errors.js";
import { CODEX_AGENT_CAPABILITIES } from "./capabilities.js";
import {
  parseCodexLaunchConfiguration,
  parseModelListResult,
  parseThreadResult,
  parseTurnStartResult,
  type CodexLaunchConfiguration,
  type CodexTokenUsage,
  type CodexTransport,
} from "./index-internal.js";
import { withDeadline, CodexRequestDeadlineError } from "./deadline.js";
import { sessionDispatcher } from "./session-events.js";
import {
  createCodexStdioTransport,
  withCodexTransportDeadline,
} from "./transport.js";
import {
  createTurnTracker,
  type CompletedTurn,
  type TurnTracker,
  itemText,
} from "./turn-tracker.js";

const TURN_TIMEOUT_MS = 30_000;
const TURN_START_CONFIRM_TIMEOUT_MS = 5_000;
const TURN_INTERRUPT_REQUEST_TIMEOUT_MS = 5_000;
const PRE_TURN_REQUEST_TIMEOUT_MS = 5_000;
const MAX_PROMPT_COMPONENT_BYTES = 1_000_000;
const MAX_PROMPT_BYTES = 4_000_000;

export interface CodexAdapterOptions {
  readonly signal?: AbortSignal;
  readonly modelSelection?: ModelSelection;
  /** Set false when the transport is owned by a Codex run. */
  readonly closeTransport?: boolean;
  /** Delivers diagnostics buffered before this session was created. */
  readonly drainDiagnostics?: () => readonly AgentDiagnostic[];
  readonly createTransport?: (
    configuration: CodexLaunchConfiguration,
    options: {
      readonly signal?: AbortSignal;
      readonly initializeTimeoutMs?: number;
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
  if (input === undefined) {
    throw new CodexAdapterError(
      "limit",
      "Codex task input is not serializable",
    );
  }
  const component = (value: string, description: string): string => {
    if (Buffer.byteLength(value, "utf8") > MAX_PROMPT_COMPONENT_BYTES) {
      throw new CodexAdapterError(
        "limit",
        `Codex ${description} exceeded ${MAX_PROMPT_COMPONENT_BYTES} bytes`,
      );
    }
    return value;
  };
  const boundedInput = component(input, "task input");
  const instructions = request.agent?.instructions?.map((value) =>
    component(`Instruction: ${value}`, "agent instruction"),
  );
  const references = request.agent?.references?.map((value) =>
    component(`Reference: ${value}`, "agent reference"),
  );
  const prompt = [
    component(
      request.agent?.goal ?? `Complete task ${request.task.id}`,
      "agent goal",
    ),
    ...(instructions ?? []),
    ...(references ?? []),
    `Task input JSON: ${boundedInput}`,
    "Return only the JSON value required by the task output schema.",
  ].join("\n");
  if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
    throw new CodexAdapterError(
      "limit",
      `Codex prompt exceeded ${MAX_PROMPT_BYTES} bytes`,
    );
  }
  return prompt;
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

  const closeTransport = async (): Promise<void> => {
    if (options.closeTransport === false) return;
    await transport.close();
  };

  const closeAfterDeadline = async (cause: unknown): Promise<void> => {
    if (!(cause instanceof CodexRequestDeadlineError)) return;
    invalidated = true;
    await closeTransport().catch(() => undefined);
  };

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
    let result: unknown;
    try {
      result = await withDeadline(
        transport.request("model/list", {}, signal),
        PRE_TURN_REQUEST_TIMEOUT_MS,
        "model/list",
      );
    } catch (cause) {
      await closeAfterDeadline(cause);
      throw cause;
    }
    const models = parseModelListResult(result);
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
      let result: unknown;
      try {
        result = await withDeadline(
          transport.request("thread/start", params, signal),
          PRE_TURN_REQUEST_TIMEOUT_MS,
          "thread/start",
        );
      } catch (cause) {
        await closeAfterDeadline(cause);
        throw cause;
      }
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
      await closeTransport().catch(() => undefined);
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
    for (const diagnostic of options.drainDiagnostics?.() ?? []) {
      reportDiagnostic(request, diagnostic);
    }
    const operation = queue.then(async () => {
      const startedAt = Date.now();
      const signal = composeSignals(options.signal, request.signal);
      const requestedSelection = selectionFor(request);
      const selection = await resolveSelection(requestedSelection, signal);
      const model = modelParams(selection);
      const id = await ensureThread(signal, selection);
      const registration = dispatcher.begin(id);
      const turnStartPromise = withDeadline(
        transport.request("turn/start", {
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
        }),
        PRE_TURN_REQUEST_TIMEOUT_MS,
        "turn/start",
      ).catch(async (cause) => {
        await closeAfterDeadline(cause);
        throw cause;
      });
      let turn: ReturnType<typeof parseTurnStartResult>;
      let tracker!: TurnTracker;
      try {
        turn = parseTurnStartResult(
          await raceWithAbort(turnStartPromise, signal),
        );
        tracker = createTurnTracker(
          registration,
          turn.id,
          request.onActivity,
          transport.respond,
        );
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
              transport.respond,
            );
            await interruptAndConfirm(turn.id, tracker, request);
          } catch (confirmationCause) {
            registration.cancel();
            invalidated = true;
            await closeTransport().catch(() => undefined);
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
    capabilities: CODEX_AGENT_CAPABILITIES,
    close: closeTransport,
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
    (adapterPromise ??= withCodexTransportDeadline(
      Promise.resolve().then(() =>
        (options.createTransport ?? createCodexStdioTransport)(validated, {
          signal: composeSignals(options.signal, request.signal),
          initializeTimeoutMs: PRE_TURN_REQUEST_TIMEOUT_MS,
          onDiagnostic: (diagnostic) => reportDiagnostic(request, diagnostic),
        }),
      ),
      PRE_TURN_REQUEST_TIMEOUT_MS,
      composeSignals(options.signal, request.signal),
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
      return CODEX_AGENT_CAPABILITIES;
    },
    execute: (request) =>
      resolveAdapter(request).then((adapter) => adapter.execute(request)),
    close: async () => {
      const adapter = await adapterPromise;
      await adapter?.close?.();
    },
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
