import { CodexAdapterError } from "./errors.js";

export class CodexRequestDeadlineError extends CodexAdapterError {
  constructor(readonly operation: string, milliseconds: number) {
    super(
      "cancellation",
      `Codex ${operation} did not complete within ${milliseconds}ms`,
    );
    this.name = "CodexRequestDeadlineError";
  }
}

export async function withDeadline<T>(
  promise: Promise<T>,
  milliseconds: number,
  operation: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(
          () => reject(new CodexRequestDeadlineError(operation, milliseconds)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
