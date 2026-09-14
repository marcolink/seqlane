import type { AgentDiagnostic } from "@seqlane/agent-adapter";
import type { ModelRef, ModelSelection } from "@seqlane/core";
import { CodexAdapterError } from "./errors.js";
import {
  parseModelListResult,
  type CodexLaunchConfiguration,
} from "./protocol.js";
import { withDeadline } from "./deadline.js";
import {
  createCodexStdioTransport,
  type CodexTransport,
  withCodexTransportDeadline,
} from "./transport.js";

const DEFAULT_MODEL_LIST_TIMEOUT_MS = 5_000;

export interface CodexModelCapabilitiesOptions {
  readonly signal?: AbortSignal;
  readonly requestTimeoutMs?: number;
  readonly onDiagnostic?: (diagnostic: AgentDiagnostic) => void;
  /** Keep a run-owned transport open after model discovery. */
  readonly closeTransport?: boolean;
  readonly createTransport?: (
    configuration: CodexLaunchConfiguration,
    options?: {
      readonly signal?: AbortSignal;
      readonly initializeTimeoutMs?: number;
      readonly onDiagnostic?: (diagnostic: AgentDiagnostic) => void;
    },
  ) => Promise<CodexTransport>;
}

/** Resolves Codex models through an owned or supplied app-server transport. */
export function createCodexModelCapabilities(
  configuration: CodexLaunchConfiguration,
  options: CodexModelCapabilitiesOptions = {},
): {
  readonly executor: "codex";
  readonly listModels: () => Promise<readonly ModelRef[]>;
  readonly resolveDefaultModel: () => Promise<ModelSelection>;
} {
  type CodexModel = ReturnType<typeof parseModelListResult>[number];
  let modelsPromise: Promise<readonly CodexModel[]> | undefined;
  const resolveModels = async () =>
    (modelsPromise ??= (async () => {
      const timeoutMs =
        options.requestTimeoutMs ?? DEFAULT_MODEL_LIST_TIMEOUT_MS;
      const createTransport =
        options.createTransport ??
        ((value: CodexLaunchConfiguration, transportOptions) =>
          createCodexStdioTransport(value, transportOptions));
      const transportPromise = Promise.resolve().then(() =>
        createTransport(configuration, {
          signal: options.signal,
          initializeTimeoutMs: timeoutMs,
          onDiagnostic: options.onDiagnostic,
        }),
      );
      const transport = await withCodexTransportDeadline(
        transportPromise,
        timeoutMs,
        options.signal,
        options.closeTransport !== false,
      );
      try {
        return parseModelListResult(
          await withDeadline(
            transport.request("model/list", {}, options.signal),
            timeoutMs,
            "model/list",
            options.signal,
          ),
        );
      } finally {
        if (options.closeTransport !== false) await transport.close();
      }
    })());

  return {
    executor: "codex",
    listModels: async () =>
      (await resolveModels()).map(({ model }) => ({
        provider: "openai" as const,
        model,
      })),
    resolveDefaultModel: async () => {
      const selected = (await resolveModels()).find((model) => model.isDefault);
      if (selected === undefined) {
        throw new CodexAdapterError(
          "configuration",
          "Codex app-server did not provide a default model",
        );
      }
      return { model: { provider: "openai", model: selected.model } };
    },
  };
}
