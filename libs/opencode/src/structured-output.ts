import { z } from "zod";

const structuredResponseSchema = z.object({
  info: z.object({
    structured: z.unknown(),
  }),
});

/** Extracts the SDK's structured result without accepting assistant text. */
export function extractStructuredOutput(response: unknown): unknown {
  const result = structuredResponseSchema.safeParse(response);
  if (!result.success || result.data.info.structured === undefined) {
    throw new Error("OpenCode response did not contain structured output");
  }

  return result.data.info.structured;
}
