import type { OpenAIModelId } from "./openai.generated.js";
import { openAIModelIds } from "./openai.generated.js";
import type { ModelRef } from "../model-ref.js";
import { z } from "zod";

export { openAIModelIds } from "./openai.generated.js";
export type { OpenAIModelId } from "./openai.generated.js";

export const openAIModelIdSchema = z.enum(openAIModelIds);

export function openai<const Model extends OpenAIModelId>(
  model: Model,
): ModelRef<"openai", Model> {
  openAIModelIdSchema.parse(model);
  return Object.freeze({ provider: "openai", model });
}
