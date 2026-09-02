import type { OutputMode } from "@seqlane/output";

export function parseOutputMode(value: string): OutputMode {
  if (
    value === "auto" ||
    value === "human" ||
    value === "ci" ||
    value === "json"
  ) {
    return value;
  }
  throw new Error("--output must be auto, human, ci, or json");
}
