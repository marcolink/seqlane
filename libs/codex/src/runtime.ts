import { isAbsolute } from "node:path";
import {
  redactAgentAdapter,
  redactAgentRuntimeModelCapabilities,
  redactOpaqueValue,
  type AgentRuntimeFactory,
} from "@seqlane/agent-adapter";
import { z } from "zod";
import { CODEX_AGENT_CAPABILITIES } from "./capabilities.js";
import { createCodexRun } from "./run.js";

const configurationSchema = z.strictObject({
  adapter: z.literal("codex"),
  workspace: z.string().min(1).optional(),
  executable: z
    .string()
    .min(1)
    .pipe(
      z.custom<string>(
        (value) => typeof value === "string" && isAbsolute(value),
        { message: "must be an absolute executable path" },
      ),
    ),
  networkAccess: z.boolean().default(false),
});

export function createCodexAgentRuntimeFactory(
  value: unknown,
): AgentRuntimeFactory {
  const configuration = configurationSchema.parse(value);
  return async (signal, workspace) => {
    const resolvedWorkspace = workspace ?? configuration.workspace;
    if (resolvedWorkspace === undefined)
      throw new Error("Codex requires a workspace");
    const redactText = createRuntimeRedactor(
      configuration.executable,
      resolvedWorkspace,
    );
    let run: ReturnType<typeof createCodexRun>;
    try {
      run = createCodexRun(
        {
          executable: configuration.executable,
          workspace: resolvedWorkspace,
          networkAccess: configuration.networkAccess,
        },
        { signal },
      );
    } catch (cause) {
      throw redactOpaqueValue(cause, redactText);
    }
    return {
      identity: "codex",
      capabilities: CODEX_AGENT_CAPABILITIES,
      modelCapabilities: redactAgentRuntimeModelCapabilities(
        run.modelCapabilities,
        redactText,
      ),
      createAdapter: (context) => {
        try {
          return run.createAdapter(context.signal, context.modelSelection);
        } catch (cause) {
          throw redactOpaqueValue(cause, redactText);
        }
      },
      redactAdapter: (adapter) => redactAgentAdapter(adapter, redactText),
      close: async () => {
        try {
          await run.close();
        } catch (cause) {
          throw redactOpaqueValue(cause, redactText);
        }
      },
    };
  };
}

function createRuntimeRedactor(
  executable: string,
  workspace: string,
): (value: string) => string {
  const values = [executable, workspace]
    .filter((value, index, all) => all.indexOf(value) === index)
    .sort((first, second) => second.length - first.length);
  return (value: string): string =>
    values.reduce(
      (message, secret) => message.split(secret).join("[REDACTED]"),
      value,
    );
}
