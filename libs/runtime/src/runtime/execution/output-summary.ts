import type { SeqlaneOutputSummary } from "@seqlane/core";

const MAX_OUTPUT_FIELDS = 8;
const MAX_OUTPUT_FIELD_LENGTH = 80;

/** Returns bounded shape information without exposing task output values. */
export function summarizeSeqlaneOutput(value: unknown): SeqlaneOutputSummary {
  if (value === null || value === undefined) return { kind: "null" };

  switch (typeof value) {
    case "boolean":
      return { kind: "boolean" };
    case "number":
      return { kind: "number" };
    case "string":
      return { kind: "string", size: value.length };
    case "bigint":
    case "symbol":
    case "function":
      return { kind: "string" };
    case "object":
      if (Array.isArray(value)) {
        return { kind: "array", size: value.length };
      }
      try {
        const fields = Object.keys(value);
        return {
          kind: "object",
          size: fields.length,
          fields: fields
            .slice(0, MAX_OUTPUT_FIELDS)
            .map((field) => field.slice(0, MAX_OUTPUT_FIELD_LENGTH)),
        };
      } catch {
        return { kind: "object" };
      }
  }

  return { kind: "null" };
}
