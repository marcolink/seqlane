export type { JsonSchema } from "./task.js";
export { resolveOpenCodeBrowserUiUrl } from "./browser-ui.js";
export { createOpenCodeRun } from "./session.js";
export type {
  OpenCodeActivity,
  OpenCodePrompt,
  OpenCodePromptResult,
  OpenCodeRun,
  OpenCodeUncertainActivity,
} from "./session.js";
export { createOpenCodeExecutor } from "./executor.js";
export type { OpenCodeExecutor, OpenCodeExecutorRequest } from "./executor.js";
export { createMastraAcpExecutor } from "./mastra-acp-executor.js";
export type { MastraAcpExecutorOptions } from "./mastra-acp-executor.js";
export { createOpenCodeModelCapabilities } from "./model-capabilities.js";
export type { OpenCodeModelCapabilities } from "./model-capabilities.js";

/** The SDK/server contract proven by the TS-004-00 contract suite. */
export const OPENCODE_SDK_VERSION = "1.18.27" as const;

export const OPENCODE_STRUCTURED_OUTPUT_FORMAT = "json_schema" as const;

export { extractStructuredOutput } from "./structured-output.js";
export {
  createStructuredOutputState,
  normalizeStructuredOutputConfiguration,
  resolveStructuredOutputStrategy,
} from "./structured-output-strategy.js";
export type {
  ResolvedStructuredOutput,
  StructuredOutputConfiguration,
  StructuredOutputDiagnostic,
  StructuredOutputState,
  StructuredOutputStrategy,
} from "./structured-output-strategy.js";
export {
  StructuredOutputCompatibilityError,
  StructuredOutputValidationError,
} from "./errors.js";
export type { StructuredOutputIssue } from "./errors.js";
export { isNativeReadbackCompatibilityError } from "./structured-output-compatibility.js";
