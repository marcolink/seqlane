export type AcpErrorCode =
  | "configuration"
  | "execution"
  | "cancellation"
  | "malformed-stream"
  | "limit"
  | "output";

export class AcpAdapterError extends Error {
  constructor(
    readonly code: AcpErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(`ACP adapter: ${message}`, { cause });
    this.name = "AcpAdapterError";
  }
}

export class AcpLimitError extends AcpAdapterError {
  constructor(
    readonly resource: string,
    readonly maximum: number,
    cause?: unknown,
  ) {
    super("limit", `${resource} exceeded the maximum of ${maximum}`, cause);
    this.name = "AcpLimitError";
  }
}

export interface AcpStructuredOutputIssue {
  readonly kind: "parse" | "validation";
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export class AcpStructuredOutputError extends AcpAdapterError {
  readonly strategy = "prompt" as const;

  constructor(
    readonly attempts: number,
    readonly issues: readonly AcpStructuredOutputIssue[],
    cause?: unknown,
  ) {
    super(
      "output",
      `structured output validation failed after ${attempts} attempt${attempts === 1 ? "" : "s"}`,
      cause,
    );
    this.name = "AcpStructuredOutputError";
  }
}
