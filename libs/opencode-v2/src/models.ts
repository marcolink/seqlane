import type { AgentRuntimeModelCapabilities } from "@seqlane/agent-adapter";
import type { ModelSelection } from "@seqlane/core";
import { OpenCodeV2Error } from "./errors.js";
import { requestOptions, type V2Client } from "./client.js";
import { defaultModelSchema, modelPageSchema } from "./schemas.js";

export function nativeModel(selection: ModelSelection) {
  return {
    providerID: selection.model.provider,
    id: selection.model.model,
    ...(selection.reasoning === undefined
      ? {}
      : { variant: selection.reasoning }),
  };
}

export async function createModelCapabilities(
  client: V2Client,
  workspace: string,
  signal: AbortSignal,
): Promise<AgentRuntimeModelCapabilities> {
  const input = { location: { directory: workspace } };
  const catalog = modelPageSchema.parse(
    await client.model.list(input, requestOptions(signal)),
  ).data;
  const enabled = catalog.filter(
    (model) => model.enabled && model.capabilities.tools,
  );
  const validateModelSelection = async (
    selection: ModelSelection,
  ): Promise<void> => {
    const model = enabled.find(
      (item) =>
        item.providerID === selection.model.provider &&
        item.id === selection.model.model,
    );
    if (model === undefined)
      throw new OpenCodeV2Error(
        "configuration",
        "authored model is unavailable or lacks tool support",
      );
    if (
      selection.reasoning !== undefined &&
      !model.variants.some((item) => item.id === selection.reasoning)
    ) {
      throw new OpenCodeV2Error(
        "configuration",
        "authored reasoning variant is unavailable",
      );
    }
  };
  return {
    executor: "opencode-v2",
    listModels: async () =>
      enabled.map((model) => ({ provider: model.providerID, model: model.id })),
    validateModelSelection,
    resolveDefaultModel: async () => {
      const value = defaultModelSchema.parse(
        await client.model.default(input, requestOptions(signal)),
      ).data;
      if (value === null)
        throw new OpenCodeV2Error(
          "configuration",
          "no native default model is available",
        );
      const selection = {
        model: { provider: value.providerID, model: value.id },
      };
      await validateModelSelection(selection);
      return selection;
    },
  };
}
