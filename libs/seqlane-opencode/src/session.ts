import { InteractionRequiredError } from "@seqlane/core";
import type { ModelSelection } from "@seqlane/core";
import type { Event as OpenCodeEvent } from "@opencode-ai/sdk/v2";
import { z } from "zod";
import { OpenCodeExecutorError } from "./errors.js";
import { StructuredOutputCompatibilityError } from "./errors.js";
import { parseOpenCodePromptResponse } from "./prompt-response.js";
import type {
  OpenCodeConnection,
  OpenCodeActivity,
  OpenCodeUncertainActivity,
  OpenCodePrompt,
  OpenCodePromptResult,
  OpenCodeRun,
} from "./protocol.js";
import { createOpenCodeTransport, type OpenCodeSession } from "./transport.js";
import { createOpenCodeSessionBrowserUrl } from "./session-browser-url.js";
import {
  createStructuredOutputState,
  type StructuredOutputState,
} from "./structured-output-strategy.js";
import { isNativeReadbackCompatibilityError } from "./structured-output-compatibility.js";
import {
  parseOpenCodeEvent,
  type OpenCodeLegacyToolObservation,
  type OpenCodeEventObservation,
  type OpenCodeToolObservation,
} from "./observations.js";

const checkpointSchema = z.object({
  sessionId: z.string().min(1),
  messageId: z.string().min(1),
});

const structuredOutputStates = new WeakMap<
  OpenCodeConnection,
  StructuredOutputState
>();

function stringField(
  details: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = details[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

interface ActivityIdentity {
  readonly kind: OpenCodeActivity["kind"];
  readonly name: string;
}

function activityIdentity(
  tool: string,
  input: Record<string, unknown> | undefined,
  metadata: Record<string, unknown> | undefined,
  previous: ActivityIdentity | undefined,
): ActivityIdentity | undefined {
  if (tool !== "skill") return { kind: "tool", name: tool };
  const name =
    stringField(metadata ?? {}, "name") ??
    stringField(input ?? {}, "name") ??
    (previous?.kind === "skill" ? previous.name : undefined);
  return name === undefined ? undefined : { kind: "skill", name };
}

function activityFromToolObservation(
  observation: OpenCodeToolObservation | OpenCodeLegacyToolObservation,
  activityIdentities: Map<string, ActivityIdentity>,
): OpenCodeActivity | undefined {
  const callID = observation.callID;
  const identity =
    observation.tool === undefined
      ? activityIdentities.get(callID)
      : activityIdentity(
          observation.tool,
          observation.input,
          observation.metadata,
          activityIdentities.get(callID),
        );
  if (
    identity === undefined ||
    callID.length > 256 ||
    identity.name.length > 256
  )
    return undefined;
  activityIdentities.set(callID, identity);
  const state =
    observation.status === "pending" ||
    observation.status === "running" ||
    observation.status === "called"
      ? "started"
      : observation.status === "progress"
        ? "progress"
        : observation.status === "completed" || observation.status === "success"
          ? "succeeded"
          : "failed";
  return {
    activityId: callID,
    kind: identity.kind,
    name: identity.name,
    state,
    ...(observation.input === undefined ? {} : { input: observation.input }),
    ...(observation.output === undefined ? {} : { output: observation.output }),
    ...(observation.metadata === undefined
      ? {}
      : { metadata: observation.metadata }),
    ...(observation.startedAt === undefined
      ? {}
      : { startedAt: observation.startedAt }),
    ...(observation.endedAt === undefined
      ? {}
      : { endedAt: observation.endedAt }),
    ...(state === "failed" ? { message: "Tool failed" } : {}),
  };
}

async function waitForInteraction(
  events: AsyncIterable<OpenCodeEvent>,
  sessionID: string,
  signal: AbortSignal,
  onActivity: ((activity: OpenCodeActivity) => void) | undefined,
  onUncertainActivity:
    ((activity: OpenCodeUncertainActivity) => void) | undefined,
  onObservation: ((observation: OpenCodeEventObservation) => void) | undefined,
  onDiagnostic: ((message: string) => void) | undefined,
): Promise<void> {
  const activityIdentities = new Map<string, ActivityIdentity>();
  const reportDiagnostic = (message: string): void => {
    try {
      onDiagnostic?.(message);
    } catch {
      // Diagnostics are best effort and must not affect execution.
    }
  };
  for await (const event of events) {
    const parsed = parseOpenCodeEvent(event, sessionID);
    if (parsed === undefined) {
      reportDiagnostic("ignored malformed OpenCode event");
      continue;
    }
    if (parsed.interaction) return;
    const observation = parsed.observation;
    if (observation !== undefined) {
      onObservation?.(observation);
      if (observation.kind === "tool") {
        const activity = activityFromToolObservation(
          observation,
          activityIdentities,
        );
        if (activity !== undefined) onActivity?.(activity);
      }
      continue;
    }
    if (parsed.legacyTool !== undefined) {
      const activity = activityFromToolObservation(
        parsed.legacyTool,
        activityIdentities,
      );
      if (activity !== undefined) onActivity?.(activity);
    }
    if (parsed.backgroundProcess) {
      // OpenCode's event does not expose a lifetime handle for this process.
      // Quarantine the session instead of passing an untrackable mutation into
      // the runtime.
      onUncertainActivity?.({ reason: "disconnect" });
    }
    if (parsed.validity === "unsupported")
      reportDiagnostic("ignored unsupported OpenCode event");
    else if (parsed.validity === "malformed")
      reportDiagnostic("ignored malformed OpenCode event");
  }
  if (!signal.aborted) {
    throw new OpenCodeExecutorError(
      "interaction event stream closed before task completion",
    );
  }
}

export type {
  OpenCodeConnection,
  OpenCodeActivity,
  OpenCodePrompt,
  OpenCodePromptResult,
  OpenCodeRun,
  OpenCodeUncertainActivity,
} from "./protocol.js";

function executorError(message: string, cause?: unknown): Error {
  return new OpenCodeExecutorError(message, cause);
}

function getStructuredOutputState(
  connection: OpenCodeConnection,
  transport: ReturnType<typeof createOpenCodeTransport>,
): StructuredOutputState {
  const existing = structuredOutputStates.get(connection);
  if (existing !== undefined) return existing;
  const state = createStructuredOutputState({
    configuration: connection.structuredOutput,
    resolveVersion: () =>
      transport.getRuntimeVersion?.() ?? Promise.resolve(undefined),
  });
  structuredOutputStates.set(connection, state);
  return state;
}

export async function createOpenCodeRun(
  connection: OpenCodeConnection,
  signal?: AbortSignal,
  configuredSelection?: ModelSelection,
): Promise<OpenCodeRun> {
  return createOpenCodeRunForSession(
    connection,
    signal,
    undefined,
    configuredSelection,
  );
}

async function createOpenCodeRunForSession(
  connection: OpenCodeConnection,
  signal?: AbortSignal,
  existingSession?: OpenCodeSession,
  configuredSelection?: ModelSelection,
  structuredOutputState?: StructuredOutputState,
): Promise<OpenCodeRun> {
  if (signal?.aborted) {
    throw executorError("run was cancelled before session creation");
  }

  const transport = createOpenCodeTransport(connection.url);
  const outputState =
    structuredOutputState ??
    connection.structuredOutputState ??
    getStructuredOutputState(connection, transport);
  let sessionID: string;
  let workspace: string | undefined;
  let browserUrl: string | undefined;
  try {
    const session =
      existingSession ??
      (await transport.createSession(connection.workspace, signal));
    sessionID = session.sessionId;
    workspace = session.workspace;
    browserUrl =
      connection.browserUiUrl === undefined
        ? undefined
        : createOpenCodeSessionBrowserUrl(
            connection.browserUiUrl,
            session.directory,
            session.sessionId,
          );
    if (signal?.aborted) {
      throw executorError("run was cancelled during session creation");
    }
  } catch (cause) {
    throw executorError("could not create an external session", cause);
  }

  let queue = Promise.resolve();
  let aborted = false;
  let abortPromise: Promise<void> | undefined;
  let terminalCheckpoint: z.infer<typeof checkpointSchema> | undefined;

  const prompt = (request: OpenCodePrompt): Promise<OpenCodePromptResult> => {
    const operation = queue.then(async () => {
      if (aborted || signal?.aborted || request.signal?.aborted) {
        throw executorError("run was cancelled before task submission");
      }

      try {
        const selected = await outputState.resolve();
        const effectiveStrategy = request.strategy ?? selected.strategy;
        const promptController = new AbortController();
        const permissionMonitorController = new AbortController();
        const requestSignal = request.signal;
        let removeAbortListener = (): void => undefined;
        const cancellation =
          requestSignal === undefined
            ? undefined
            : new Promise<void>((resolve, reject) => {
                const onAbort = () => {
                  requestSignal.removeEventListener("abort", onAbort);
                  void abort().then(() => {
                    promptController.abort();
                    resolve();
                  }, reject);
                };
                removeAbortListener = () => {
                  requestSignal.removeEventListener("abort", onAbort);
                };
                if (requestSignal.aborted) onAbort();
                else
                  requestSignal.addEventListener("abort", onAbort, {
                    once: true,
                  });
              });
        try {
          let events: AsyncIterable<OpenCodeEvent>;
          try {
            events = await transport.subscribeEvents(
              permissionMonitorController.signal,
            );
          } catch (cause) {
            throw executorError(
              "could not monitor external interaction requirements",
              cause,
            );
          }
          const interactionRequest = waitForInteraction(
            events,
            sessionID,
            permissionMonitorController.signal,
            request.onActivity,
            request.onUncertainActivity,
            request.onObservation,
            request.onDiagnostic,
          )
            .then(() => ({ type: "interaction" as const }))
            .catch((cause) => ({ type: "monitor-error" as const, cause }));
          const effectiveRequest: OpenCodePrompt = {
            ...request,
            strategy: effectiveStrategy,
            retryCount: selected.retryCount,
            ...(configuredSelection === undefined
              ? {}
              : {
                  selection: configuredSelection,
                  ...(configuredSelection.reasoning === undefined
                    ? {}
                    : { variant: configuredSelection.reasoning }),
                }),
          };
          const promptResponse = transport
            .prompt(sessionID, effectiveRequest, promptController.signal)
            .then(
              (response) => ({ type: "response" as const, response }),
              (cause: unknown) => ({ type: "transport-error" as const, cause }),
            );
          const result = await Promise.race([
            promptResponse,
            interactionRequest,
            ...(cancellation === undefined
              ? []
              : [cancellation.then(() => ({ type: "cancelled" as const }))]),
          ]);
          if (request.signal?.aborted && cancellation !== undefined) {
            await cancellation;
            throw executorError("run was cancelled during task submission");
          }

          if (result.type === "cancelled") {
            throw executorError("run was cancelled during task submission");
          }

          if (result.type === "monitor-error") {
            request.onRunInvalidated?.();
            promptController.abort();
            await abort().catch(() => undefined);
            throw executorError(
              "could not monitor external interaction requirements",
              result.cause,
            );
          }

          if (result.type === "interaction") {
            request.onRunInvalidated?.();
            promptController.abort();
            await abort().catch(() => undefined);
            await promptResponse.catch(() => undefined);
            throw new InteractionRequiredError("user-input");
          }

          if (result.type === "transport-error") {
            if (
              effectiveStrategy === "native" &&
              isNativeReadbackCompatibilityError(result.cause)
            ) {
              outputState.markNativeReadbackIncompatible(selected.version);
              throw new StructuredOutputCompatibilityError(
                selected.version,
                sessionID,
                result.cause,
              );
            }
            request.onUncertainActivity?.({ reason: "disconnect" });
            throw executorError("structured task request failed", result.cause);
          }

          const parsed = parseOpenCodePromptResponse(
            result.response,
            effectiveStrategy,
          );
          if (parsed.checkpoint.sessionId !== sessionID) {
            throw executorError("prompt response belonged to another session");
          }
          if (effectiveStrategy === "native" && transport.listMessages) {
            try {
              await transport.listMessages(sessionID, promptController.signal);
            } catch (cause) {
              if (isNativeReadbackCompatibilityError(cause)) {
                outputState.markNativeReadbackIncompatible(selected.version);
                throw new StructuredOutputCompatibilityError(
                  selected.version,
                  sessionID,
                  cause,
                );
              }
              throw executorError("could not read the external session", cause);
            }
          }
          terminalCheckpoint = parsed.checkpoint;
          return {
            structured: parsed.structured,
            ...(parsed.text === undefined ? {} : { text: parsed.text }),
            ...(parsed.metrics === undefined
              ? {}
              : { metrics: parsed.metrics }),
            ...(parsed.observation === undefined
              ? {}
              : { observation: parsed.observation }),
          };
        } finally {
          permissionMonitorController.abort();
          removeAbortListener();
        }
      } catch (cause) {
        if (cause instanceof InteractionRequiredError) throw cause;
        if (
          cause instanceof OpenCodeExecutorError ||
          cause instanceof StructuredOutputCompatibilityError
        )
          throw cause;
        throw executorError("structured task request failed", cause);
      }
    });
    queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };

  const abort = (): Promise<void> => {
    if (abortPromise) return abortPromise;
    aborted = true;
    abortPromise = transport
      .abort(sessionID)
      .then(() => undefined)
      .catch((cause) => {
        throw executorError("could not abort the external session", cause);
      });
    return abortPromise;
  };

  const checkpoint = async (): Promise<z.infer<typeof checkpointSchema>> => {
    if (terminalCheckpoint === undefined) {
      throw executorError("session has no terminal message checkpoint");
    }
    return terminalCheckpoint;
  };

  const fork = async (
    checkpointInput: unknown,
    selection?: ModelSelection,
  ): Promise<OpenCodeRun> => {
    const checkpoint = checkpointSchema.safeParse(checkpointInput);
    if (!checkpoint.success || checkpoint.data.sessionId !== sessionID) {
      throw executorError("session checkpoint does not belong to this session");
    }
    try {
      const child = await transport.forkSession(
        sessionID,
        checkpoint.data.messageId,
        signal,
      );
      if (selection !== undefined) {
        await transport.configureSession(
          child.sessionId,
          { messageId: checkpoint.data.messageId, selection },
          signal,
        );
      }
      return createOpenCodeRunForSession(
        connection,
        signal,
        {
          ...child,
          ...(workspace === undefined ? {} : { workspace }),
        },
        selection,
        outputState,
      );
    } catch (cause) {
      throw executorError("native session checkpoint fork failed", cause);
    }
  };

  return {
    ...(browserUrl === undefined ? {} : { browserUrl }),
    ...(workspace === undefined ? {} : { workspace }),
    prompt,
    structuredOutput: async () => {
      const selected = await outputState.resolve();
      return {
        strategy: selected.strategy,
        retryCount: selected.retryCount,
        reason: selected.reason,
        ...(selected.version === undefined
          ? {}
          : { version: selected.version }),
        report: selected.report,
      };
    },
    checkpoint,
    fork,
    abort,
  };
}
