import type { ModelRef } from "./model-ref.js";
import { z } from "zod";

const modelReferenceSchema = z.string().min(1);

export function model(reference: string): ModelRef {
  modelReferenceSchema.parse(reference);
  const separator = reference.indexOf("/");
  if (separator <= 0 || separator === reference.length - 1) {
    throw new Error('Model reference must use the "provider/model" format');
  }

  return Object.freeze({
    provider: reference.slice(0, separator),
    model: reference.slice(separator + 1),
  });
}
