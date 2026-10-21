export class OpenCodeV2Error extends Error {
  constructor(
    readonly code:
      | "configuration"
      | "compatibility"
      | "protocol"
      | "execution"
      | "output"
      | "termination"
      | "limit",
    message: string,
    cause?: unknown,
  ) {
    super(`OpenCode V2: ${message}`, { cause });
    this.name = "OpenCodeV2Error";
  }
}
