import { isAbsolute } from "node:path";
import type { AgentRuntimeFactory } from "@seqlane/agent-adapter";
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
    const run = createCodexRun(
      {
        executable: configuration.executable,
        workspace: resolvedWorkspace,
        networkAccess: configuration.networkAccess,
      },
      { signal },
    );
    return {
      identity: "codex",
      capabilities: CODEX_AGENT_CAPABILITIES,
      modelCapabilities: run.modelCapabilities,
      createAdapter: (context) =>
        run.createAdapter(context.signal, context.modelSelection),
      redactAdapter: (adapter) => adapter,
      close: () => run.close(),
    };
  };
}
