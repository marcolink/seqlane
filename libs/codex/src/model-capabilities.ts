import type { ModelRef, ModelSelection } from "@seqlane/core";
import { CodexAdapterError } from "./errors.js";
import {
  parseModelListResult,
  type CodexLaunchConfiguration,
} from "./protocol.js";
import { withDeadline } from "./deadline.js";
import { createCodexStdioTransport, type CodexTransport } from "./transport.js";

const DEFAULT_MODEL_LIST_TIMEOUT_MS = 5_000;

export interface CodexModelCapabilitiesOptions {
  readonly signal?: AbortSignal;
  readonly requestTimeoutMs?: number;
  readonly createTransport?: (
    configuration: CodexLaunchConfiguration,
  ) => Promise<CodexTransport>;
}

/** Resolves Codex models through a short-lived, run-independent app-server. */
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
      const transport = await (
        options.createTransport ?? ((value) => createCodexStdioTransport(value))
      )(configuration);
      try {
        return parseModelListResult(
          await withDeadline(
            transport.request("model/list", {}, options.signal),
            options.requestTimeoutMs ?? DEFAULT_MODEL_LIST_TIMEOUT_MS,
            "model/list",
          ),
        );
      } finally {
        await transport.close();
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
