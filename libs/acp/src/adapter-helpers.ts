import { Effect } from "effect";
import type { AgentAdapterRequest } from "@seqlane/agent-adapter";
import { AcpAdapterError } from "./errors.js";
import { interactionError } from "./interaction-error.js";

export function awaitAbort(signal: AbortSignal): Effect.Effect<never, unknown> {
  return Effect.callback((resume) => {
    const onAbort = (): void => resume(Effect.fail(signal.reason));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });
}

export function awaitOwned<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return Effect.runPromise(
    Effect.raceFirst(
      Effect.promise(() => operation),
      awaitAbort(signal),
    ),
  );
}

export function reportDiagnostic(
  request: AgentAdapterRequest,
  code: string,
  message: string,
): void {
  try {
    request.onDiagnostic?.({ code, message });
  } catch {
    // Diagnostics are best effort and must not affect execution.
  }
}

export function abortError(request: AgentAdapterRequest): AcpAdapterError {
  return new AcpAdapterError(
    "cancellation",
    "ACP execution was cancelled",
    request.signal.reason,
  );
}

export { interactionError };
