export class OpenCodeExecutorError extends Error {
  constructor(message: string, cause?: unknown) {
    super(`OpenCode executor: ${message}`, { cause });
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
