import {
  redactAgentAdapter,
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
    createAdapter: () => createAcpAdapter(configuration.configuration),
    redactAdapter: (adapter) => redactAdapter(adapter, configuration),
  });
}

function redactAdapter(
  adapter: Parameters<typeof redactAgentAdapter>[0],
  configuration: z.output<typeof configurationSchema>,
): Parameters<typeof redactAgentAdapter>[0] {
  const secrets = [
    ...(configuration.configuration.args ?? []),
    ...Object.values(configuration.configuration.env ?? {}).filter(
      (value): value is string => typeof value === "string",
    ),
  ].sort((first, second) => second.length - first.length);
  const redact = (value: string): string =>
    secrets.reduce(
      (message, secret) => message.split(secret).join("[REDACTED]"),
      value,
    );
  return redactAgentAdapter(adapter, redact);
}
