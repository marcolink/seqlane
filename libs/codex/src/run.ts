import type { AgentAdapter } from "@seqlane/agent-adapter";
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
  const transport = async (): Promise<CodexTransport> => {
    if (closed) throw new Error("Codex run is closed");
    return (transportPromise ??= (
      options.createTransport ?? createCodexStdioTransport
    )(configuration, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onDiagnostic: ({ message }) => process.emitWarning(message),
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
