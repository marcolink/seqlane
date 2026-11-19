import type { OperationalHostOptions } from "./runtime/operations/types.js";
import { createOperationalWorkflow } from "./runtime/operations/registration.js";

export { createOperationalWorkflow };
export type {
  OperationalHost,
  OperationalHostOptions,
  OperationalEventSink,
  OperationalSessionUiNotifier,
  OperationalWorkflowRegistration,
  OperationalWorkflowSource,
} from "./runtime/operations/types.js";

/** Loads Node HTTP and SQLite only when hosted execution is requested. */
export async function createOperationalHost(options: OperationalHostOptions) {
  const { createNativeOperationalHost } =
    await import("./runtime/operations/host.js");
  return createNativeOperationalHost(options);
}
