export type AcpErrorCode =
  | "configuration"
  | "execution"
  | "cancellation"
  | "malformed-stream"
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

export class AcpMalformedStreamError extends AcpAdapterError {
  constructor(
    readonly chunkType: string | undefined,
    cause?: unknown,
  ) {
    super(
      "malformed-stream",
      `received malformed stream data${chunkType === undefined ? "" : ` for ${chunkType}`}`,
      cause,
    );
    this.name = "AcpMalformedStreamError";
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
