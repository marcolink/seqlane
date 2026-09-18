import type { AgentRuntimeFactory } from "@seqlane/agent-adapter";
import { createAcpAgentRuntimeFactory } from "@seqlane/acp-adapter";
import { createCodexAgentRuntimeFactory } from "@seqlane/codex-adapter";
import { createOpenCodeAgentRuntimeFactory } from "@seqlane/opencode-adapter";
import { z } from "zod";

const adapterIdentitySchema = z.object({ adapter: z.string().min(1) });

export const agentRuntimeConfigurationEnvironment =
  "SEQLANE_RUNTIME_ADAPTER_CONFIG" as const;

export class AgentRuntimeConfigurationError extends Error {
  constructor(message: string, cause?: unknown) {
    super(`Agent runtime configuration: ${message}`, { cause });
    this.name = "AgentRuntimeConfigurationError";
  }
}

/** Selects a concrete adapter factory without interpreting its configuration. */
export function createAgentRuntimeFactory(value: unknown): AgentRuntimeFactory {
  const identity = adapterIdentitySchema.safeParse(value);
  if (!identity.success) {
    throw new AgentRuntimeConfigurationError(
      "configuration is invalid",
      identity.error,
    );
  }
  try {
    switch (identity.data.adapter) {
      case "acp":
        return createAcpAgentRuntimeFactory(value);
      case "codex":
        return createCodexAgentRuntimeFactory(value);
      case "opencode":
        return createOpenCodeAgentRuntimeFactory(value);
      default:
        throw new AgentRuntimeConfigurationError(
          `adapter "${identity.data.adapter}" is unavailable`,
        );
    }
  } catch (cause) {
    if (cause instanceof AgentRuntimeConfigurationError) throw cause;
    throw new AgentRuntimeConfigurationError("configuration is invalid", cause);
  }
}

/** Loads application-owned adapter selection without disclosing its values. */
export function loadAgentRuntimeFactory(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AgentRuntimeFactory {
  const encoded = environment[agentRuntimeConfigurationEnvironment];
  if (encoded === undefined || encoded.length === 0) {
    throw new AgentRuntimeConfigurationError("configuration is missing");
  }
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch (cause) {
    throw new AgentRuntimeConfigurationError(
      "configuration is not valid JSON",
      cause,
    );
  }
  return createAgentRuntimeFactory(value);
}
