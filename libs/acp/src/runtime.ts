import {
  redactAgentAdapter,
  redactOpaqueValue,
  type AgentRuntimeFactory,
} from "@seqlane/agent-adapter";
import { z } from "zod";
import { createAcpAdapter } from "./adapter.js";
import { acpLaunchConfigurationSchema } from "./contracts.js";

const configurationSchema = z.strictObject({
  adapter: z.literal("acp"),
  configuration: acpLaunchConfigurationSchema.strict(),
});

export function createAcpAgentRuntimeFactory(
  value: unknown,
): AgentRuntimeFactory {
  const configuration = configurationSchema.parse(value);
  const redactText = createRuntimeRedactor(configuration);
  return async () => ({
    identity: "acp",
    capabilities: {
      execute: true,
      modelSelection: false,
      structuredOutput: true,
      sessionReuse: configuration.configuration.persistSession,
      checkpoint: false,
      fork: false,
      activity: true,
      sessionUi: false,
    },
    createAdapter: () => {
      try {
        return createAcpAdapter(configuration.configuration);
      } catch (cause) {
        throw redactOpaqueValue(cause, redactText);
      }
    },
    redactAdapter: (adapter) => redactAdapter(adapter, configuration),
  });
}

function createRuntimeRedactor(
  configuration: z.output<typeof configurationSchema>,
): (value: string) => string {
  const secrets = [
    ...(configuration.configuration.args ?? []).filter(
      (value) => value.length > 0,
    ),
    ...Object.values(configuration.configuration.env ?? {}).filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    ),
  ].sort((first, second) => second.length - first.length);
  return (value: string): string =>
    secrets.reduce(
      (message, secret) => message.split(secret).join("[REDACTED]"),
      value,
    );
}

function redactAdapter(
  adapter: Parameters<typeof redactAgentAdapter>[0],
  configuration: z.output<typeof configurationSchema>,
): Parameters<typeof redactAgentAdapter>[0] {
  return redactAgentAdapter(adapter, createRuntimeRedactor(configuration));
}
