import type { ActiveSession } from "@agentclientprotocol/sdk";
import { InteractionRequiredError } from "@seqlane/core";
import type { AgentAdapterRequest } from "@seqlane/agent-adapter";
import type { AcpLaunchConfiguration } from "./contracts.js";
import { AcpAdapterError } from "./errors.js";
import { AcpToolReducer } from "./stream.js";
import type { AcpTransport } from "./transport.js";
import { executePromptTask } from "./prompt-execution.js";
import {
  abortError,
  interactionError,
  reportDiagnostic,
} from "./adapter-helpers.js";
import {
  acquireAcpTransport,
  closeAcpSession,
  createAcpSession,
  type AcpTransportState,
} from "./session-lifecycle.js";

export interface AcpExecutionState {
  readonly transport: AcpTransportState;
  persistentSession: ActiveSession | undefined;
  closePromise: Promise<void> | undefined;
}

export async function executeAcpRequest(
  state: AcpExecutionState,
  configuration: AcpLaunchConfiguration,
  retryCount: number,
  request: AgentAdapterRequest,
): Promise<unknown> {
  if (state.closePromise !== undefined) {
    throw new AcpAdapterError("execution", "ACP adapter is closed");
  }
  if (request.modelSelection !== undefined) {
    throw new AcpAdapterError(
      "configuration",
      "ACP v1 configured model selection is fixed at adapter creation",
    );
  }
  if (request.signal.aborted) throw abortError(request);
  let transport: AcpTransport;
  try {
    transport = await acquireAcpTransport(
      state.transport,
      configuration,
      request.signal,
    );
  } catch (cause) {
    if (request.signal.aborted) {
      throw new AcpAdapterError(
        "cancellation",
        "ACP execution was cancelled during connection setup",
        new AggregateError([request.signal.reason, cause]),
      );
    }
    if (cause instanceof AcpAdapterError) throw cause;
    throw new AcpAdapterError(
      "execution",
      "ACP connection setup failed",
      cause,
    );
  }
  const signal = AbortSignal.any([request.signal, transport.signal]);
  transport.clearInteraction();
  const reducer = new AcpToolReducer(request.invocationId, {
    onActivity: request.onActivity,
    onObservation: request.onObservation,
    onDiagnostic: (diagnostic) =>
      reportDiagnostic(request, diagnostic.code, diagnostic.message),
  });
  let session = state.persistentSession;
  let ownsSession = false;
  let result: unknown;
  let primaryFailure: unknown;
  let hasPrimaryFailure = false;
  try {
    if (session === undefined) {
      session = await createAcpSession(transport, configuration, signal);
      ownsSession = true;
      if (configuration.persistSession) {
        state.persistentSession = session;
        ownsSession = false;
      }
    }
    result = await executePromptTask({
      request,
      transport,
      session,
      reducer,
      signal,
      retryCount,
    });
  } catch (cause) {
    hasPrimaryFailure = true;
    if (request.signal.aborted) {
      primaryFailure = new AcpAdapterError(
        "cancellation",
        "ACP execution was cancelled",
        new AggregateError([request.signal.reason, cause]),
      );
    } else if (transport.interactionRequested()) {
      primaryFailure = interactionError(cause);
    } else if (cause instanceof AcpAdapterError) primaryFailure = cause;
    else
      primaryFailure = new AcpAdapterError(
        "execution",
        "ACP execution failed",
        cause,
      );
  }

  transport.clearInteraction();
  if (ownsSession && session !== undefined) {
    try {
      if (transport.signal.aborted) session.dispose();
      else await closeAcpSession(transport, session);
      if (!configuration.persistSession && !transport.supportsSessionClose) {
        if (
          state.transport.promise !== undefined &&
          (await state.transport.promise.catch(() => undefined)) === transport
        ) {
          state.transport.promise = undefined;
          state.transport.controller = undefined;
        }
      }
    } catch (cleanupCause) {
      if (!hasPrimaryFailure) {
        hasPrimaryFailure = true;
        primaryFailure = cleanupCause;
        try {
          await transport.close();
        } catch (terminationCause) {
          if (cleanupCause instanceof InteractionRequiredError) {
            primaryFailure = interactionError(
              new AggregateError([cleanupCause, terminationCause]),
            );
          } else {
            primaryFailure = new AcpAdapterError(
              cleanupCause instanceof AcpAdapterError
                ? cleanupCause.code
                : "execution",
              "ACP session cleanup and process termination were not confirmed",
              new AggregateError([cleanupCause, terminationCause]),
            );
          }
        }
      } else {
        if (primaryFailure instanceof InteractionRequiredError) {
          const interactionFailure = interactionError(
            new AggregateError([primaryFailure, cleanupCause]),
          );
          try {
            await transport.close();
            primaryFailure = interactionFailure;
          } catch (terminationCause) {
            primaryFailure = interactionError(
              new AggregateError([interactionFailure, terminationCause]),
            );
          }
        } else {
          primaryFailure = new AcpAdapterError(
            primaryFailure instanceof AcpAdapterError
              ? primaryFailure.code
              : "execution",
            "ACP execution failed and session cleanup also failed",
            new AggregateError([primaryFailure, cleanupCause]),
          );
          try {
            await transport.close();
          } catch (terminationCause) {
            primaryFailure = new AcpAdapterError(
              primaryFailure instanceof AcpAdapterError
                ? primaryFailure.code
                : "execution",
              "ACP execution and process termination were not confirmed",
              new AggregateError([primaryFailure, terminationCause]),
            );
          }
        }
      }
    }
  }
  if (hasPrimaryFailure) throw primaryFailure;
  return result;
}
