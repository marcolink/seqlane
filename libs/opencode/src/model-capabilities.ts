import type { ModelRef, ModelSelection } from "@seqlane/core";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { z } from "zod";
import { createOpenCodeClient } from "./client.js";
import { OpenCodeModelSelectionError } from "./errors.js";

const providerModelSchema = z.looseObject({
  id: z.string().min(1),
  variants: z
    .record(
      z.string().min(1),
      z.looseObject({ disabled: z.boolean().optional() }),
    )
    .optional(),
});

const providerSchema = z.looseObject({
  id: z.string().min(1),
  models: z.record(z.string(), providerModelSchema),
});

const providerListResponseSchema = z.looseObject({
  all: z.array(providerSchema),
  default: z.record(z.string(), z.string().min(1)),
  connected: z.array(z.string()),
});

const configuredProviderCatalogSchema = z.looseObject({
  providers: z.array(providerSchema),
  default: z.record(z.string(), z.string().min(1)),
});

type ProviderCatalog = z.infer<typeof configuredProviderCatalogSchema>;

/** Seqlane-owned model capabilities backed by one OpenCode runtime. */
export interface OpenCodeModelCapabilities {
  readonly executor: "opencode";
  readonly listModels: () => Promise<readonly ModelRef[]>;
  readonly resolveDefaultModel: () => Promise<ModelSelection>;
  readonly validateModelSelection: (selection: ModelSelection) => Promise<void>;
}

/** Creates model discovery/default resolution without exposing OpenCode types. */
export function createOpenCodeModelCapabilities(
  url: string,
  workspace?: string,
): OpenCodeModelCapabilities {
  return createOpenCodeModelCapabilitiesFromClient(
    createOpenCodeClient(url),
    workspace,
  );
}

function createOpenCodeModelCapabilitiesFromClient(
  client: OpencodeClient,
  workspace: string | undefined,
): OpenCodeModelCapabilities {
  return {
    executor: "opencode",

    async listModels() {
      const response = await client.provider.list(
        workspace === undefined ? {} : { directory: workspace },
        { throwOnError: true },
      );
      const catalog = providerListResponseSchema.parse(response.data);
      return Object.freeze(
        catalog.all
          .filter((provider) => catalog.connected.includes(provider.id))
          .flatMap((provider) =>
            Object.values(provider.models).map((model) =>
              Object.freeze({ provider: provider.id, model: model.id }),
            ),
          ),
      );
    },

    async resolveDefaultModel() {
      const catalog = await loadCatalog(client, workspace);
      const provider = catalog.providers.find(
        (candidate) => catalog.default[candidate.id] !== undefined,
      );
      if (provider === undefined) {
        throw new Error("OpenCode did not report a configured default model");
      }

      const modelId = catalog.default[provider.id];
      if (modelId === undefined) {
        throw new Error(
          `OpenCode did not report a default model for provider "${provider.id}"`,
        );
      }
      const model = Object.values(provider.models).find(
        (candidate) => candidate.id === modelId,
      );
      if (model === undefined) {
        throw new Error(
          `OpenCode default model "${provider.id}/${modelId}" is not in its configured catalog`,
        );
      }

      return Object.freeze({
        model: Object.freeze({ provider: provider.id, model: model.id }),
      });
    },

    async validateModelSelection(selection) {
      if (selection.reasoning === undefined) return;
      const response = await client.provider.list(
        workspace === undefined ? {} : { directory: workspace },
        { throwOnError: true },
      );
      const catalog = providerListResponseSchema.parse(response.data);
      const provider = catalog.all.find(
        (candidate) =>
          candidate.id === selection.model.provider &&
          catalog.connected.includes(candidate.id),
      );
      const model = provider?.models[selection.model.model];
      const variant = model?.variants?.[selection.reasoning];
      if (variant === undefined || variant.disabled === true) {
        throw new OpenCodeModelSelectionError(selection);
      }
    },
  };
}

async function loadCatalog(
  client: OpencodeClient,
  workspace: string | undefined,
): Promise<ProviderCatalog> {
  const response = await client.config.providers(
    workspace === undefined ? {} : { directory: workspace },
    { throwOnError: true },
  );
  return configuredProviderCatalogSchema.parse(response.data);
}
