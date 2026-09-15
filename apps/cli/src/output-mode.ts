import { z } from "zod";

export const outputModeSchema = z.enum(["auto", "human", "ci"]);
export type OutputMode = z.infer<typeof outputModeSchema>;

export const outputModeOptions = outputModeSchema.options;

export function parseOutputMode(value: string): OutputMode {
  const result = outputModeSchema.safeParse(value);
  if (result.success) return result.data;
  const lastOption = outputModeOptions[outputModeOptions.length - 1];
  throw new Error(
    `--output must be ${outputModeOptions.slice(0, -1).join(", ")}, or ${lastOption}`,
  );
}
