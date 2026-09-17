import type { ModelSelection } from "@seqlane/core";

export class OpenCodeExecutorError extends Error {
  constructor(message: string, cause?: unknown) {
    super(`OpenCode executor: ${message}`, { cause });
  }
}

/** A configured model exists but cannot accept its requested native setting. */
export class OpenCodeModelSelectionError extends OpenCodeExecutorError {
  readonly selection: ModelSelection;

  constructor(selection: ModelSelection) {
    super(
      `model "${selection.model.provider}/${selection.model.model}" does not support reasoning effort "${selection.reasoning}"`,
    );
    this.name = "OpenCodeModelSelectionError";
    this.selection = selection;
  }
}

export class OpenCodeServiceStartupError extends OpenCodeExecutorError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "OpenCodeServiceStartupError";
  }
}

export class OpenCodeServiceCleanupError extends OpenCodeExecutorError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "OpenCodeServiceCleanupError";
  }
}

export class OpenCodeProviderApiError extends OpenCodeExecutorError {
  constructor(
    readonly statusCode: number | undefined,
    readonly retryable: boolean,
    cause?: unknown,
  ) {
    super(
      statusCode === 429
        ? "provider rejected the request because the rate or usage limit was reached (HTTP 429)"
        : `provider request failed${statusCode === undefined ? "" : ` (HTTP ${statusCode})`}`,
      cause,
    );
    this.name = "OpenCodeProviderApiError";
  }
}

export interface StructuredOutputIssue {
  readonly kind: "parse" | "validation";
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export class StructuredOutputValidationError extends Error {
  readonly strategy = "prompt" as const;

  constructor(
    readonly attempts: number,
    readonly issues: readonly StructuredOutputIssue[],
    cause?: unknown,
  ) {
    super(
      `Prompt structured output validation failed after ${attempts} attempt${attempts === 1 ? "" : "s"}`,
      { cause },
    );
    this.name = "StructuredOutputValidationError";
  }
}

export class StructuredOutputCompatibilityError extends Error {
  readonly strategy = "native" as const;
  readonly runtime = "opencode" as const;

  constructor(
    readonly version: string | undefined,
    readonly sessionId: string | undefined,
    cause?: unknown,
  ) {
    super(
      "OpenCode native structured output is not compatible with persisted message readback; use prompt strategy or a verified fixed OpenCode version",
      { cause },
    );
    this.name = "StructuredOutputCompatibilityError";
  }
}
