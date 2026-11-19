import { traceCarrierSchema, type TraceCarrier } from "./validation.js";

export { traceCarrierSchema };
export type { TraceCarrier };

export function encodeTraceCarrier(carrier: TraceCarrier): string {
  const parsed = traceCarrierSchema.safeParse(carrier);
  if (!parsed.success) throw new TypeError("Invalid trace carrier");
  return JSON.stringify(parsed.data);
}

export function decodeTraceCarrier(encoded: string): TraceCarrier {
  try {
    const value: unknown = JSON.parse(encoded);
    const parsed = traceCarrierSchema.safeParse(value);
    if (parsed.success) return parsed.data;
  } catch {
    // Normalize malformed JSON and schema failures at the private boundary.
  }
  throw new TypeError("Invalid trace carrier");
}
