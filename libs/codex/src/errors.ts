export type CodexAdapterErrorCode =
  | "configuration"
  | "protocol"
  | "execution"
  | "cancellation"
  | "output"
  | "limit";

export class CodexAdapterError extends Error {
  constructor(
    readonly code: CodexAdapterErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(`Codex adapter: ${message}`, { cause });
    this.name = "CodexAdapterError";
  }
}

export class CodexProtocolError extends CodexAdapterError {
  constructor(message: string, cause?: unknown) {
    super("protocol", message, cause);
    this.name = "CodexProtocolError";
  }
}

export class CodexStructuredOutputError extends CodexAdapterError {
  constructor(message: string, cause?: unknown) {
    super("output", message, cause);
    this.name = "CodexStructuredOutputError";
  }
}
