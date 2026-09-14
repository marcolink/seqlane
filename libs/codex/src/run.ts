import type { AgentAdapter, AgentDiagnostic } from "@seqlane/agent-adapter";
import type { ModelSelection } from "@seqlane/core";
import { createCodexAdapter } from "./adapter.js";
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
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onDiagnostic: (diagnostic) => {
        if (transportOptions.onDiagnostic !== undefined) {
          transportOptions.onDiagnostic(diagnostic);
        } else if (pendingDiagnostics.length < 32) {
          pendingDiagnostics.push(diagnostic);
        }
      },
    }));
  };
  const modelCapabilities = createCodexModelCapabilities(configuration, {
    createTransport: transport,
    closeTransport: false,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return {
    modelCapabilities,
    createAdapter(
      signal: AbortSignal,
      modelSelection?: ModelSelection,
    ): AgentAdapter {
      return createCodexAdapter(configuration, {
        signal,
        ...(modelSelection === undefined ? {} : { modelSelection }),
        closeTransport: false,
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
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      if (transportPromise !== undefined) {
        await (await transportPromise).close();
      }
    },
  };
}

export type CodexRun = ReturnType<typeof createCodexRun>;
