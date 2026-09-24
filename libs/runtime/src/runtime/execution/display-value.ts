import type { SeqlaneDisplayValue } from "@seqlane/core";
import { isJsonValue } from "@seqlane/core";

export function toSeqlaneDisplayValue(value: unknown): SeqlaneDisplayValue {
  if (!isJsonValue(value)) {
    return { state: "omitted", reason: "unavailable" };
  }
  return { state: "present", value };
}
