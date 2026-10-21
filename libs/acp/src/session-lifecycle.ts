import {
  methods,
  type ActiveSession,
  type SessionConfigOption,
} from "@agentclientprotocol/sdk";
import type { AcpLaunchConfiguration } from "./contracts.js";
import { AcpAdapterError } from "./errors.js";
import { awaitOwned } from "./adapter-helpers.js";
import { awaitSdkWithin } from "./bounded-sdk-wait.js";
import { createAcpTransport, type AcpTransport } from "./transport.js";

const CANCEL_CONFIRM_TIMEOUT_MS = 2_000;

export interface AcpTransportState {
  promise: Promise<AcpTransport> | undefined;
  controller: AbortController | undefined;
}

type ModelOption = Extract<SessionConfigOption, { type: "select" }>;

function modelOption(
  options: readonly SessionConfigOption[] | null | undefined,
): ModelOption | undefined {
  return options?.find(
    (option): option is ModelOption =>
      option.type === "select" && option.category === "model",
  );
}

function modelValueExists(option: ModelOption, value: string): boolean {
  return option.options.some((groupOrValue) => {
    if ("value" in groupOrValue) return groupOrValue.value === value;
    return groupOrValue.options.some((candidate) => candidate.value === value);
  });
}

async function selectConfiguredModel(
  transport: AcpTransport,
  session: ActiveSession,
  configuration: AcpLaunchConfiguration,
): Promise<void> {
  if (configuration.model === undefined) return;
  const option = modelOption(session.newSessionResponse.configOptions);
  if (option === undefined || !modelValueExists(option, configuration.model)) {
    throw new AcpAdapterError(
      "configuration",
      `configured ACP model "${configuration.model}" is not available in the agent's advertised model options`,
    );
  }
  if (option.currentValue === configuration.model) return;
  const response = await transport.context.request(
    methods.agent.session.setConfigOption,
    {
      sessionId: session.sessionId,
      configId: option.id,
      value: configuration.model,
    },
  );
  if (
    modelOption(response.configOptions)?.currentValue !== configuration.model
  ) {
    throw new AcpAdapterError(
      "configuration",
      `ACP agent did not confirm configured model "${configuration.model}"`,
    );
  }
}

export async function closeAcpSession(
  transport: AcpTransport,
  session: ActiveSession,
): Promise<void> {
  try {
    if (!transport.supportsSessionClose) {
      await transport.close();
      return;
    }
    const closeRequest = transport.context.request(
      methods.agent.session.close,
      {
        sessionId: session.sessionId,
      },
    );
    void closeRequest.catch(() => undefined);
    try {
      const closed = await awaitSdkWithin(
        closeRequest,
        CANCEL_CONFIRM_TIMEOUT_MS,
      );
      if (closed.timedOut) {
        throw new AcpAdapterError(
          "cancellation",
          "ACP session close was not confirmed",
        );
      }
    } catch (cause) {
      try {
        await transport.close();
      } catch (terminationCause) {
        throw new AcpAdapterError(
          "cancellation",
          "ACP session close failed and process termination was not confirmed",
          new AggregateError([cause, terminationCause]),
        );
      }
      throw cause;
    }
  } finally {
    session.dispose();
  }
}

export async function acquireAcpTransport(
  state: AcpTransportState,
  configuration: AcpLaunchConfiguration,
  signal: AbortSignal,
): Promise<AcpTransport> {
  signal.throwIfAborted();
  if (state.promise !== undefined) {
    const existingPromise = state.promise;
    let existing: AcpTransport | undefined;
    try {
      existing = await awaitOwned(existingPromise, signal);
    } catch (cause) {
      if (signal.aborted) throw cause;
      if (state.promise === existingPromise) state.promise = undefined;
      existing = undefined;
    }
    if (existing !== undefined && !existing.signal.aborted) return existing;
    if (state.promise === existingPromise) state.promise = undefined;
  }
  signal.throwIfAborted();
  const controller = new AbortController();
  state.controller = controller;
  const created = createAcpTransport(configuration, controller.signal).catch(
    (cause: unknown) => {
      if (state.controller === controller) {
        state.promise = undefined;
        state.controller = undefined;
      }
      throw cause;
    },
  );
  state.promise = created;
  const abortCreation = (): void => controller.abort(signal.reason);
  signal.addEventListener("abort", abortCreation, { once: true });
  try {
    return await awaitOwned(created, signal);
  } catch (cause) {
    if (!signal.aborted) throw cause;
    controller.abort(signal.reason);
    let cleanupCause: unknown;
    let cleanupFailed = false;
    try {
      const lateTransport = await created;
      await lateTransport.close();
    } catch (lateCause) {
      cleanupFailed = true;
      cleanupCause = lateCause;
    }
    if (cleanupFailed) {
      throw new AcpAdapterError(
        "cancellation",
        "ACP connection acquisition was cancelled and cleanup failed",
        new AggregateError([signal.reason, cause, cleanupCause]),
      );
    }
    throw new AcpAdapterError(
      "cancellation",
      "ACP connection acquisition was cancelled",
      new AggregateError([signal.reason, cause]),
    );
  } finally {
    signal.removeEventListener("abort", abortCreation);
  }
}

export async function createAcpSession(
  transport: AcpTransport,
  configuration: AcpLaunchConfiguration,
  signal: AbortSignal,
): Promise<ActiveSession> {
  try {
    const session = await awaitOwned(
      transport.context
        .buildSession({
          cwd: configuration.cwd ?? process.cwd(),
          mcpServers: [],
        })
        .start(),
      signal,
    );
    try {
      await awaitOwned(
        selectConfiguredModel(transport, session, configuration),
        signal,
      );
      return session;
    } catch (cause) {
      if (signal.aborted) {
        session.dispose();
      } else {
        try {
          await closeAcpSession(transport, session);
        } catch (cleanupCause) {
          throw new AcpAdapterError(
            "configuration",
            "ACP model selection failed and session cleanup also failed",
            new AggregateError([cause, cleanupCause]),
          );
        }
      }
      throw cause;
    }
  } catch (cause) {
    if (signal.aborted) {
      try {
        await transport.close();
      } catch (cleanupCause) {
        throw new AcpAdapterError(
          "cancellation",
          "ACP session setup was cancelled and process termination was not confirmed",
          new AggregateError([signal.reason, cause, cleanupCause]),
        );
      }
    }
    throw cause;
  }
}
