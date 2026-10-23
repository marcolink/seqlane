import type {
  AgentActivity,
  AgentAdapter,
  AgentAdapterRequest,
} from "@seqlane/agent-adapter";
import {
  jsonValueSchema,
  type JsonValue,
  type ModelSelection,
} from "@seqlane/core";
import type { SeqlaneObservation } from "@seqlane/protocol";
import { Effect, Exit, Scope } from "effect";
import { buildOpenCodePrompt } from "./task-prompt.js";
import {
  buildStructuredOutputPrompt,
  buildStructuredOutputRepairPrompt,
} from "./task-prompt.js";
import { toOpenCodeJsonSchema } from "./task-schema.js";
import {
  parsePromptJson,
  summarizeStructuredOutputIssues,
  validatePromptJson,
} from "./structured-output-parser.js";
import {
  OpenCodeExecutorError,
  StructuredOutputValidationError,
} from "./errors.js";
import type { ResolvedStructuredOutput } from "./structured-output-strategy.js";
import type {
  OpenCodeActivity,
  OpenCodeConnection,
  OpenCodePrompt,
  OpenCodePromptResult,
  OpenCodeRun,
} from "./protocol.js";
import { awaitOwnedCleanup } from "./owned-cleanup.js";
import { createOpenCodeRun } from "./session.js";

export interface OpenCodeAdapterOptions {
  /** Runtime-wide cancellation for session creation and session operations. */
  readonly signal?: AbortSignal;
  /** Pins one model selection to every prompt in this adapter session. */
  readonly modelSelection?: ModelSelection;
}

function promptStrategyDiagnostic(
  selection: ResolvedStructuredOutput,
): string | undefined {
  if (selection.strategy !== "prompt" || selection.reason === "explicit") {
    return undefined;
  }
  const version =
    selection.version === undefined ? "" : ` for OpenCode ${selection.version}`;
  const reason =
    selection.reason === "affected-version"
      ? "the native implementation is on the compatibility list"
      : selection.reason === "unknown-version"
        ? "the OpenCode version is not verified"
        : selection.reason === "runtime-downgrade"
          ? "native output readback was not compatible"
          : "the runtime selected the compatibility fallback";
  return (
    `OpenCode structured output fallback is active${version}: using prompt mode because ${reason}. ` +
    "The JSON response is validated and repaired before task completion."
  );
}

function normalizeActivity(activity: OpenCodeActivity): AgentActivity {
  return {
    activityId: activity.activityId,
    kind: activity.kind,
    name: activity.name,
    state: activity.state,
    ...(activity.input === undefined ? {} : { input: activity.input }),
    ...(activity.output === undefined ? {} : { output: activity.output }),
    ...(activity.metadata === undefined ? {} : { metadata: activity.metadata }),
    ...(activity.startedAt === undefined
      ? {}
      : { startedAt: activity.startedAt }),
    ...(activity.endedAt === undefined ? {} : { endedAt: activity.endedAt }),
    ...(activity.message === undefined ? {} : { message: activity.message }),
  };
}

type ObservationAvailability = NonNullable<
  SeqlaneObservation["availability"]
>[number];

function jsonValueOrUnavailable(
  value: unknown,
  path: string,
  availability: ObservationAvailability[],
): JsonValue | undefined {
  const parsed = jsonValueSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  availability.push({ path, reason: "not-json-representable" });
  return undefined;
}

function modelRequestValue(
  prompt: OpenCodePrompt,
  availability: ObservationAvailability[],
  nativeRequest?: unknown,
): JsonValue {
  const value: Record<string, JsonValue> = { text: prompt.text };
  let schemaValue: unknown = prompt.schema;
  try {
    // Zod adds non-enumerable runtime metadata to its JSON Schema output.
    // Clone it away before validating the JSON payload.
    schemaValue = structuredClone(prompt.schema);
  } catch {
    schemaValue = undefined;
  }
  const schema = jsonValueOrUnavailable(
    schemaValue,
    "model.request.schema",
    availability,
  );
  if (schema !== undefined) value.schema = schema;
  if (prompt.strategy !== undefined) value.strategy = prompt.strategy;
  if (prompt.retryCount !== undefined) value.retryCount = prompt.retryCount;
  if (prompt.tools !== undefined) {
    const tools = jsonValueOrUnavailable(
      prompt.tools,
      "model.request.tools",
      availability,
    );
    if (tools !== undefined) value.tools = tools;
  }
  if (prompt.selection !== undefined) {
    const selection = jsonValueOrUnavailable(
      prompt.selection,
      "model.request.selection",
      availability,
    );
    if (selection !== undefined) value.selection = selection;
  }
  if (prompt.variant !== undefined) value.variant = prompt.variant;
  if (nativeRequest !== undefined) {
    const native = jsonValueOrUnavailable(
      nativeRequest,
      "model.request.native",
      availability,
    );
    if (native !== undefined) value.native = native;
  }
  return value;
}

function reportCanonicalObservation(
  request: AgentAdapterRequest,
  observation: SeqlaneObservation,
): void {
  request.onObservation?.(observation);
}

function modelObservation(
  request: AgentAdapterRequest,
  prompt: OpenCodePrompt,
  attemptIndex: number,
  options: {
    readonly state: SeqlaneObservation["state"];
    readonly response?: OpenCodePromptResult;
    readonly error?: string;
    readonly nativeRequest?: unknown;
    readonly nativeResponse?: unknown;
  },
): SeqlaneObservation {
  const response = options.response;
  const native = response?.observation;
  const metrics = response?.metrics;
  const selection = prompt.selection ?? request.modelSelection;
  const availability: ObservationAvailability[] = [];
  const responseValue: Record<string, JsonValue> = {};
  if (response?.structured !== undefined) {
    const structured = jsonValueOrUnavailable(
      response.structured,
      "model.response.structured",
      availability,
    );
    if (structured !== undefined) responseValue.structured = structured;
  }
  if (response?.text !== undefined) responseValue.text = response.text;
  const nativeResponse =
    response?.nativeResponse !== undefined
      ? response.nativeResponse
      : options.nativeResponse !== undefined
        ? options.nativeResponse
        : native;
  if (nativeResponse !== undefined) {
    const source = jsonValueOrUnavailable(
      nativeResponse,
      "model.response.native",
      availability,
    );
    if (source !== undefined) responseValue.native = source;
  }
  const error = options.error ?? native?.error;
  return {
    observationId: `${request.invocationId}:model:${attemptIndex}`,
    kind: "model",
    state: options.state,
    attemptIndex,
    model: {
      operation: "chat",
      ...(metrics?.provider === undefined
        ? native?.provider === undefined
          ? selection?.model.provider === undefined
            ? {}
            : { provider: selection.model.provider }
          : { provider: native.provider }
        : { provider: metrics.provider }),
      ...(metrics?.model === undefined
        ? native?.model === undefined
          ? selection?.model.model === undefined
            ? {}
            : { model: selection.model.model }
          : { model: native.model }
        : { model: metrics.model }),
      ...(native?.messageID === undefined
        ? {}
        : { responseId: native.messageID }),
      ...(native?.finish === undefined
        ? {}
        : { finishReasons: [native.finish] }),
      request: modelRequestValue(prompt, availability, options.nativeRequest),
      ...(response === undefined && Object.keys(responseValue).length === 0
        ? {}
        : { response: responseValue }),
      ...(metrics?.tokens === undefined
        ? {}
        : {
            usage: {
              inputTokens: metrics.tokens.input,
              outputTokens: metrics.tokens.output,
              reasoningTokens: metrics.tokens.reasoning,
              cacheReadTokens: metrics.tokens.cacheRead,
              cacheWriteTokens: metrics.tokens.cacheWrite,
            },
          }),
      ...(metrics?.cost === undefined ? {} : { cost: metrics.cost }),
      ...(native?.created === undefined ? {} : { startedAt: native.created }),
      ...(native?.completed === undefined ? {} : { endedAt: native.completed }),
      ...(error === undefined ? {} : { error }),
    },
    ...(availability.length === 0 ? {} : { availability }),
  };
}

function reportAdapterDiagnostic(
  request: AgentAdapterRequest,
  code: string,
  message: string,
): void {
  const callback = request.onDiagnostic;
  if (callback === undefined) return;
  try {
    callback({ code, message });
  } catch {
    // Diagnostics are best effort and must not affect execution.
  }
}

interface CreateAdapterForRunOptions {
  readonly resolveRun: (signal: AbortSignal) => Promise<OpenCodeRun>;
  readonly initialRun?: OpenCodeRun;
  readonly configuredSelection?: ModelSelection;
  readonly sessionUi: () => Promise<string | undefined>;
  readonly hasSessionUi: boolean;
  readonly onRunInvalidated?: () => void;
}

function createOpenCodeRunTracker(
  resolveRun: (signal: AbortSignal) => Promise<OpenCodeRun>,
  initialRun?: OpenCodeRun,
) {
  const scope = Effect.runSync(Scope.make("sequential"));
  const pendingRuns = new Map<
    Promise<OpenCodeRun>,
    {
      readonly tracked: Promise<OpenCodeRun>;
      readonly controller: AbortController;
    }
  >();
  const ownedRuns = new Set<OpenCodeRun>(
    initialRun === undefined ? [] : [initialRun],
  );
  const closingRuns = new Set<Promise<void>>();
  const closeOperations = new WeakMap<OpenCodeRun, Promise<void>>();
  let closed = false;
  let closePromise: Promise<void> | undefined;

  const closeRun = (run: OpenCodeRun): Promise<void> => {
    const existing = closeOperations.get(run);
    if (existing !== undefined) return existing;
    const closing = run.close();
    closeOperations.set(run, closing);
    return closing;
  };

  if (initialRun !== undefined) {
    Effect.runSync(
      Scope.addFinalizer(
        scope,
        Effect.promise(() => closeRun(initialRun)),
      ),
    );
  }

  const release = (run: OpenCodeRun): Promise<void> => {
    ownedRuns.delete(run);
    const closing = closeRun(run);
    closingRuns.add(closing);
    void closing
      .finally(() => closingRuns.delete(closing))
      .catch(() => undefined);
    return closing;
  };

  return {
    resolve(signal: AbortSignal): Promise<OpenCodeRun> {
      if (closed) {
        return Promise.reject(new OpenCodeExecutorError("adapter is closed"));
      }
      const controller = new AbortController();
      const acquireRun = Effect.acquireRelease(
        Effect.tryPromise({
          try: async (scopeSignal) => {
            const run = await resolveRun(
              AbortSignal.any([signal, scopeSignal, controller.signal]),
            );
            return {
              ...run,
              close: () => closeRun(run),
            };
          },
          catch: (cause) => cause,
        }),
        (run) =>
          Effect.promise(() => closeRun(run)).pipe(
            Effect.orElseSucceed(() => undefined),
          ),
      );
      const source = Effect.runPromise(
        Effect.provideService(acquireRun, Scope.Scope, scope),
      );
      const existing = pendingRuns.get(source);
      if (existing !== undefined) return existing.tracked;
      const tracked = source.then(
        async (run) => {
          pendingRuns.delete(source);
          if (closed) {
            await release(run);
            throw new OpenCodeExecutorError("adapter is closed");
          }
          ownedRuns.add(run);
          return run;
        },
        (cause: unknown) => {
          pendingRuns.delete(source);
          throw cause;
        },
      );
      pendingRuns.set(source, { tracked, controller });
      return tracked;
    },
    release,
    close(): Promise<void> {
      if (closePromise !== undefined) return closePromise;
      closed = true;
      closePromise = (async () => {
        for (const pending of pendingRuns.values()) pending.controller.abort();
        let cleanupFailure: unknown;
        try {
          await awaitOwnedCleanup(
            Promise.allSettled(
              [...pendingRuns.values()].map(({ tracked }) => tracked),
            ),
            "OpenCode run acquisition did not terminate before cleanup deadline",
          );
          const releases = await Promise.allSettled(
            [...ownedRuns].map(release),
          );
          const concurrent = await Promise.allSettled([...closingRuns]);
          const failed = [...releases, ...concurrent].find(
            (result) => result.status === "rejected",
          );
          if (failed?.status === "rejected") cleanupFailure = failed.reason;
        } catch (cause) {
          cleanupFailure = cause;
        } finally {
          await Effect.runPromise(Scope.close(scope, Exit.void));
        }
        if (cleanupFailure !== undefined) throw cleanupFailure;
      })();
      return closePromise;
    },
  };
}

function createRunInvalidation(
  callback: (() => void) | undefined,
  release: (run: OpenCodeRun) => Promise<void>,
) {
  let invalidated = false;
  return {
    invalidate(): void {
      if (invalidated) return;
      invalidated = true;
      callback?.();
    },
    async release(run: OpenCodeRun | undefined): Promise<void> {
      if (invalidated && run !== undefined) await release(run);
    },
  };
}

function createAdapterForRun({
  resolveRun: resolveUntrackedRun,
  initialRun,
  configuredSelection,
  sessionUi,
  hasSessionUi,
  onRunInvalidated,
}: CreateAdapterForRunOptions): AgentAdapter {
  const runTracker = createOpenCodeRunTracker(resolveUntrackedRun, initialRun);
  const resolveRun = runTracker.resolve;

  return {
    capabilities: {
      execute: true,
      modelSelection: true,
      structuredOutput: true,
      sessionReuse: true,
      checkpoint: true,
      fork: true,
      activity: true,
      sessionUi: hasSessionUi,
    },

    execute(request: AgentAdapterRequest): Promise<unknown> {
      return Effect.runPromise(
        Effect.scoped(
          Effect.tryPromise({
            try: async () => {
              let run: OpenCodeRun | undefined;
              const invalidation = createRunInvalidation(
                onRunInvalidated,
                runTracker.release,
              );
              try {
                const schema = toOpenCodeJsonSchema(request.task);
                run = await resolveRun(request.signal);
                const selection = await run.structuredOutput?.();
                const strategy = selection?.strategy ?? "native";
                const retryCount = selection?.retryCount ?? 0;
                const diagnostic =
                  selection === undefined
                    ? undefined
                    : promptStrategyDiagnostic(selection);
                if (diagnostic !== undefined) {
                  reportAdapterDiagnostic(
                    request,
                    "structured-output",
                    diagnostic,
                  );
                }

                const basePrompt = buildOpenCodePrompt(
                  request.task,
                  request.input,
                  request.agent,
                );
                let promptText =
                  strategy === "prompt"
                    ? buildStructuredOutputPrompt(basePrompt, schema)
                    : basePrompt;
                let attempts = 0;
                let lastIssues: StructuredOutputValidationError | undefined;

                while (true) {
                  attempts += 1;
                  selection?.report?.({ type: "attempt", attempt: attempts });
                  let nativeRequest: unknown;
                  let nativeResponse: unknown;
                  const prompt: OpenCodePrompt = {
                    text: promptText,
                    schema,
                    strategy,
                    retryCount,
                    tools: { read: true },
                    ...(lastIssues === undefined
                      ? {}
                      : { tools: { "*": false, StructuredOutput: true } }),
                    selection: request.modelSelection ?? configuredSelection,
                    signal: request.signal,
                    ...(attempts === 1
                      ? { onExecutionStarted: request.onExecutionStarted }
                      : {}),
                    onNativeRequest: (value) => {
                      nativeRequest = value;
                    },
                    onNativeResponse: (value) => {
                      nativeResponse = value;
                    },
                    onActivity: (activity) =>
                      request.onActivity?.(normalizeActivity(activity)),
                    onUncertainActivity: request.onUncertainActivity,
                    onDiagnostic: (message) =>
                      reportAdapterDiagnostic(
                        request,
                        "opencode-event",
                        message,
                      ),
                    onRunInvalidated: invalidation.invalidate,
                  };
                  const attemptIndex = attempts - 1;
                  reportCanonicalObservation(
                    request,
                    modelObservation(request, prompt, attemptIndex, {
                      state: "started",
                    }),
                  );
                  let response: OpenCodePromptResult;
                  try {
                    response = await run.prompt(prompt);
                  } catch (cause) {
                    reportCanonicalObservation(
                      request,
                      modelObservation(request, prompt, attemptIndex, {
                        state: request.signal.aborted ? "cancelled" : "failed",
                        error:
                          cause instanceof Error
                            ? cause.message
                            : "model exchange failed",
                        nativeRequest,
                        nativeResponse,
                      }),
                    );
                    throw cause;
                  }
                  reportCanonicalObservation(
                    request,
                    modelObservation(request, prompt, attemptIndex, {
                      state:
                        response.observation?.error === undefined
                          ? "succeeded"
                          : "failed",
                      response,
                      nativeRequest,
                    }),
                  );
                  if (response.metrics !== undefined) {
                    request.onMetrics?.(response.metrics);
                  }
                  if (strategy === "native") {
                    selection?.report?.({
                      type: "completed",
                      attempt: attempts,
                      success: true,
                    });
                    return response.structured;
                  }

                  try {
                    const parsed = parsePromptJson(response.text ?? "");
                    const output = validatePromptJson(
                      parsed,
                      request.task.output,
                    );
                    selection?.report?.({
                      type: "completed",
                      attempt: attempts,
                      success: true,
                    });
                    return output;
                  } catch (cause) {
                    const validationError =
                      cause instanceof StructuredOutputValidationError
                        ? cause
                        : new StructuredOutputValidationError(
                            1,
                            [
                              {
                                kind: "validation",
                                code: "schema_validation_failed",
                                message:
                                  "Output did not satisfy the task schema",
                              },
                            ],
                            cause,
                          );
                    lastIssues = validationError;
                    if (attempts > retryCount) {
                      selection?.report?.({
                        type: "completed",
                        attempt: attempts,
                        success: false,
                      });
                      throw new StructuredOutputValidationError(
                        attempts,
                        validationError.issues,
                        validationError,
                      );
                    }
                    promptText = buildStructuredOutputRepairPrompt(
                      summarizeStructuredOutputIssues(validationError.issues),
                    );
                  }
                }
              } finally {
                if (request.signal.aborted) invalidation.invalidate();
                await invalidation.release(run);
              }
            },
            catch: (cause) => cause,
          }),
        ),
      );
    },

    close: runTracker.close,

    ...(hasSessionUi ? { sessionUi } : {}),
    captureCheckpoint: async () =>
      (await resolveRun(new AbortController().signal)).checkpoint(),
    fork: async ({ checkpoint, modelSelection }) => {
      const child = await (
        await resolveRun(new AbortController().signal)
      ).fork(checkpoint, modelSelection ?? configuredSelection);
      let childRun: Promise<OpenCodeRun> | undefined = Promise.resolve(child);
      const resolveChildRun = (signal: AbortSignal): Promise<OpenCodeRun> =>
        (childRun ??= resolveRun(signal).then((parent) =>
          parent.fork(checkpoint, modelSelection ?? configuredSelection),
        ));
      return createAdapterForRun({
        resolveRun: resolveChildRun,
        initialRun: child,
        configuredSelection: modelSelection ?? configuredSelection,
        sessionUi: async () =>
          (await resolveChildRun(new AbortController().signal)).browserUrl,
        hasSessionUi: child.browserUrl !== undefined,
        onRunInvalidated: () => {
          childRun = undefined;
        },
      });
    },
  };
}

/** Test seam for the adapter contract; production uses the SDK-backed factory below. */
export function createOpenCodeAdapterForRun(
  run: OpenCodeRun,
  modelSelection?: ModelSelection,
): AgentAdapter {
  const startedRun: OpenCodeRun = {
    ...run,
    prompt: async (request) => {
      request.onExecutionStarted?.();
      return run.prompt(request);
    },
  };
  return createAdapterForRun({
    resolveRun: () => Promise.resolve(startedRun),
    initialRun: startedRun,
    configuredSelection: modelSelection,
    sessionUi: async () => run.browserUrl,
    hasSessionUi: run.browserUrl !== undefined,
  });
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

/** Creates the sole OpenCode task adapter backed by the OpenCode SDK. */
export function createOpenCodeAdapter(
  connection: OpenCodeConnection,
  options: OpenCodeAdapterOptions = {},
): AgentAdapter {
  let run: Promise<OpenCodeRun> | undefined;
  const resolveRun = (signal: AbortSignal): Promise<OpenCodeRun> =>
    (run ??= createOpenCodeRun(
      connection,
      composeSignals(options.signal, signal),
      options.modelSelection,
    ));

  return createAdapterForRun({
    resolveRun,
    configuredSelection: options.modelSelection,
    sessionUi: async () =>
      (await resolveRun(options.signal ?? new AbortController().signal))
        .browserUrl,
    hasSessionUi: connection.browserUiUrl !== undefined,
    onRunInvalidated: () => {
      run = undefined;
    },
  });
}
