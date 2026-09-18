import {
  redactAgentAdapter,
  redactOpaqueValue,
  AgentRuntimeFactory,
  type AgentRuntimeModelCapabilities,
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
    const redactText = createRuntimeRedactor(configuration);
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
      modelCapabilities: redactModelCapabilities(
        createOpenCodeModelCapabilities(configuration.url, resolvedWorkspace),
        redactText,
      ),
      createAdapter: (context) => {
        try {
          return createOpenCodeAdapter(
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
          );
        } catch (cause) {
          throw redactOpaqueValue(cause, redactText);
        }
      },
      redactAdapter: (adapter) => redactAgentAdapter(adapter, redactText),
    };
  };
}

function createRuntimeRedactor(
  configuration: z.output<typeof configurationSchema>,
): (value: string) => string {
  const url = new URL(configuration.url);
  const secrets = [
    url.pathname,
    url.search,
    url.hash,
    ...url.pathname.split("/"),
    ...url.searchParams.values(),
    url.hash.slice(1),
    ...rawUrlParameterValues(url.search.slice(1)),
    ...rawUrlParameterValues(url.hash.slice(1)),
  ]
    .flatMap((value) => [value, decodeUrlComponent(value)])
    .filter((value) => value.length > 0 && value !== "/")
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort((first, second) => second.length - first.length);
  return (value: string): string =>
    secrets.reduce(
      (message, secret) => message.split(secret).join("[REDACTED]"),
      value,
    );
}

function rawUrlParameterValues(component: string): string[] {
  return component.split("&").flatMap((parameter) => {
    const separator = parameter.indexOf("=");
    return separator === -1 ? [] : [parameter.slice(separator + 1)];
  });
}

function decodeUrlComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function redactModelCapabilities(
  capabilities: AgentRuntimeModelCapabilities,
  redactText: (value: string) => string,
): AgentRuntimeModelCapabilities {
  return {
    ...capabilities,
    listModels: async () => {
      try {
        return await capabilities.listModels();
      } catch (cause) {
        throw redactOpaqueValue(cause, redactText);
      }
    },
    resolveDefaultModel: async () => {
      try {
        return await capabilities.resolveDefaultModel();
      } catch (cause) {
        throw redactOpaqueValue(cause, redactText);
      }
    },
    ...(capabilities.validateModelSelection === undefined
      ? {}
      : {
          validateModelSelection: async (selection) => {
            try {
              await capabilities.validateModelSelection?.(selection);
            } catch (cause) {
              throw redactOpaqueValue(cause, redactText);
            }
          },
        }),
  };
}
