import { decodeTraceCarrier } from "@seqlane/protocol/private/trace-carrier";
import type { TraceCarrier } from "@seqlane/protocol/private/trace-carrier";

export const traceCarrierEnvironment = "SEQLANE_TRACE_CARRIER";

/** Reads and removes private parent context before workflow imports can run. */
export function captureTraceCarrierEnvironment(
  environment: NodeJS.ProcessEnv,
): TraceCarrier | undefined {
  const encoded = environment[traceCarrierEnvironment];
  delete environment[traceCarrierEnvironment];
  return encoded === undefined ? undefined : decodeTraceCarrier(encoded);
}
