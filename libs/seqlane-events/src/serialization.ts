import type { SeqlaneExecutionEvent } from "./contracts.js";
import { isSeqlaneExecutionEvent } from "./validation.js";

export function encodeSeqlaneExecutionEvent(
  event: SeqlaneExecutionEvent,
): string {
  if (!isSeqlaneExecutionEvent(event))
    throw new TypeError("Invalid Seqlane execution event");
  try {
    const encoded = JSON.stringify(event);
    if (encoded === undefined) throw new TypeError();
    return encoded;
  } catch {
    throw new TypeError("Invalid Seqlane execution event");
  }
}

export function decodeSeqlaneExecutionEvent(
  encoded: string,
): SeqlaneExecutionEvent {
  if (typeof encoded !== "string")
    throw new TypeError("Invalid Seqlane execution event");
  try {
    const value: unknown = JSON.parse(encoded);
    if (isSeqlaneExecutionEvent(value)) return value;
  } catch {
    // Normalize parser and validation failures at the protocol boundary.
  }
  throw new TypeError("Invalid Seqlane execution event");
}
