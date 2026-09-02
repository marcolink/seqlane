export class OpenCodeExecutorError extends Error {
  constructor(message: string, cause?: unknown) {
    super(`OpenCode executor: ${message}`, { cause });
  }
}
