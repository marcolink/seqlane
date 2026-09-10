/**
 * Compatibility module for the former direct-run composition root.
 * Direct runs now use the Mastra-backed runner profile.
 */
export { resolveRuntimeProfile } from "../../runner/profile/runtime-profile.js";
export type {
  RuntimeExecution,
  RuntimeSessionUiNotifier,
} from "../../runner/profile/runtime-profile.js";
