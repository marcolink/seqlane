import {
  redactAgentAdapter,
  AgentRuntimeFactory,
} from "@seqlane/agent-adapter";
import { z } from "zod";
import { createOpenCodeAdapter } from "./adapter.js";
import { resolveOpenCodeBrowserUiUrl } from "./browser-ui.js";
import { createOpenCodeModelCapabilities } from "./model-capabilities.js";

const httpUrlSchema = z.url().pipe(
  z.custom<string>(
    (value) => {
      try {
        if (typeof value !== "string") return false;
        const url = new URL(value);
        return (
          (url.protocol === "http:" || url.protocol === "https:") &&
          url.username.length === 0 &&
          url.password.length === 0
        );
      } catch {
        return false;
      }
    },
    { message: "must be an HTTP(S) URL without embedded credentials" },
  ),
);

const configurationSchema = z.strictObject({
  adapter: z.literal("opencode"),
  url: httpUrlSchema,
  workspace: z.string().min(1).optional(),
});

export function createOpenCodeAgentRuntimeFactory(
  value: unknown,
): AgentRuntimeFactory {
  const configuration = configurationSchema.parse(value);
  return async (signal, workspace) => {
    const browserUiUrl = await resolveOpenCodeBrowserUiUrl(
      configuration.url,
      signal,
    );
    const resolvedWorkspace = workspace ?? configuration.workspace;
    return {
      identity: "opencode",
      capabilities: {
        execute: true,
        modelSelection: true,
        structuredOutput: true,
        sessionReuse: true,
        checkpoint: true,
        fork: true,
        activity: true,
        sessionUi: browserUiUrl !== undefined,
      },
      modelCapabilities: createOpenCodeModelCapabilities(
        configuration.url,
        resolvedWorkspace,
      ),
      createAdapter: (context) =>
        createOpenCodeAdapter(
          {
            url: configuration.url,
            ...(resolvedWorkspace === undefined
              ? {}
              : { workspace: resolvedWorkspace }),
            ...(browserUiUrl === undefined ? {} : { browserUiUrl }),
          },
          {
            signal: context.signal,
            ...(context.modelSelection === undefined
              ? {}
              : { modelSelection: context.modelSelection }),
          },
        ),
      redactAdapter: (adapter) => redactAdapter(adapter, configuration),
    };
  };
}

function redactAdapter(
  adapter: Parameters<typeof redactAgentAdapter>[0],
  configuration: z.output<typeof configurationSchema>,
): Parameters<typeof redactAgentAdapter>[0] {
  const url = new URL(configuration.url);
  const secrets = [
    ...url.pathname.split("/"),
    ...url.searchParams.values(),
    url.hash.slice(1),
  ]
    .filter((value) => value.length > 0)
    .sort((first, second) => second.length - first.length);
  const redact = (value: string): string =>
    secrets.reduce(
      (message, secret) => message.split(secret).join("[REDACTED]"),
      value,
    );
  return redactAgentAdapter(adapter, redact);
}
