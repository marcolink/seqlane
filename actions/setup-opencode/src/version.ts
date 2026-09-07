import { z } from "zod";

const exactVersionSchema = z
  .string()
  .regex(
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  );

export function parseVersion(input: string): string {
  const result = exactVersionSchema.safeParse(input);
  if (!result.success) {
    throw new Error(
      "version must be an exact semantic release version such as 1.18.27",
    );
  }
  return result.data;
}
