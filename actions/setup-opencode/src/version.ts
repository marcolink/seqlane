import { z } from "zod";

const numericIdentifier = "(?:0|[1-9][0-9]*)";
const nonNumericIdentifier = "(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)";
const prereleaseIdentifier = `(?:${numericIdentifier}|${nonNumericIdentifier})`;
const exactVersionSchema = z
  .string()
  .regex(
    new RegExp(
      `^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-${prereleaseIdentifier}(?:\\.${prereleaseIdentifier})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
    ),
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
