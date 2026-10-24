import { createHash } from "node:crypto";
import { z } from "zod";

const jsonSchema = z.json();
type JsonValue = z.infer<typeof jsonSchema>;

function serializeCanonical(value: JsonValue): string {
  if (Array.isArray(value))
    return `[${value.map(serializeCanonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(
        ([key, entry]) => `${JSON.stringify(key)}:${serializeCanonical(entry)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function canonicalReviewJson(value: unknown): string {
  return serializeCanonical(jsonSchema.parse(value));
}

export function reviewSha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
