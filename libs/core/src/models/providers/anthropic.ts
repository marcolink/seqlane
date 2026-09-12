import type { AnthropicModelId } from "./anthropic.generated.js";
import { anthropicModelIds } from "./anthropic.generated.js";
import type { ModelRef } from "../model-ref.js";
import { z } from "zod";

export { anthropicModelIds } from "./anthropic.generated.js";
export type { AnthropicModelId } from "./anthropic.generated.js";

export const anthropicModelIdSchema = z.enum(anthropicModelIds);

export function anthropic<const Model extends AnthropicModelId>(
  model: Model,
): ModelRef<"anthropic", Model> {
  anthropicModelIdSchema.parse(model);
  return Object.freeze({ provider: "anthropic", model });
}
