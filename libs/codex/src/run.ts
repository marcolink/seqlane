import type { AgentAdapter, AgentDiagnostic } from "@seqlane/agent-adapter";
import type { ModelSelection } from "@seqlane/core";
import { createCodexAdapter } from "./adapter.js";
import { CodexAdapterError } from "./errors.js";
import { createCodexModelCapabilities } from "./model-capabilities.js";
import type { CodexLaunchConfiguration } from "./protocol.js";
import { createCodexStdioTransport, type CodexTransport } from "./transport.js";

export interface CodexRunOptions {
  readonly signal?: AbortSignal;
  readonly createTransport?: (
    configuration: CodexLaunchConfiguration,
    options: {
      readonly signal?: AbortSignal;
      readonly initializeTimeoutMs?: number;
      readonly onDiagnostic?: (diagnostic: {
        readonly code: string;
        readonly message: string;
      }) => void;
    },
  ) => Promise<CodexTransport>;
}

/** Owns one app-server connection for all sessions in one Seqlane run. */
export function createCodexRun(
  configuration: CodexLaunchConfiguration,
  options: CodexRunOptions = {},
) {
  let transportPromise: Promise<CodexTransport> | undefined;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const runController = new AbortController();
  const runSignal =
    options.signal === undefined
      ? runController.signal
      : AbortSignal.any([options.signal, runController.signal]);
  const pendingDiagnostics: AgentDiagnostic[] = [];
  const transport = async (
    _configuration: CodexLaunchConfiguration,
    transportOptions: {
      readonly signal?: AbortSignal;
      readonly initializeTimeoutMs?: number;
      readonly onDiagnostic?: (diagnostic: AgentDiagnostic) => void;
    } = {},
  ): Promise<CodexTransport> => {
    if (closed) throw new Error("Codex run is closed");
    return (transportPromise ??= (
      options.createTransport ?? createCodexStdioTransport
    )(configuration, {
      ...transportOptions,
      signal: runSignal,
      onDiagnostic: (diagnostic) => {
        if (transportOptions.onDiagnostic !== undefined) {
          transportOptions.onDiagnostic(diagnostic);
        } else if (pendingDiagnostics.length < 32) {
          pendingDiagnostics.push(diagnostic);
        }
      },
    }));
  };
  const close = (): Promise<void> =>
    (closePromise ??= (async () => {
      closed = true;
      runController.abort(
        new CodexAdapterError("cancellation", "Codex run is closed"),
      );
      const created = await transportPromise?.catch(() => undefined);
      await created?.close();
    })());
  const modelCapabilities = createCodexModelCapabilities(configuration, {
    createTransport: transport,
    closeTransport: false,
    signal: runSignal,
  });
  return {
    modelCapabilities,
    createAdapter(
      signal: AbortSignal,
      modelSelection?: ModelSelection,
    ): AgentAdapter {
      return createCodexAdapter(configuration, {
        signal: AbortSignal.any([runSignal, signal]),
        ...(modelSelection === undefined ? {} : { modelSelection }),
        closeTransport: false,
        onUnconfirmedTermination: close,
        isRunClosed: () => closed,
        drainDiagnostics: () => {
          const diagnostics = pendingDiagnostics.splice(
            0,
            pendingDiagnostics.length,
          );
          return diagnostics;
        },
        createTransport: transport,
      });
    },
    close,
  };
}

export type CodexRun = ReturnType<typeof createCodexRun>;
