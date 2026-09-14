import { CodexAdapterError } from "./errors.js";

export class CodexRequestDeadlineError extends CodexAdapterError {
  constructor(
    readonly operation: string,
    milliseconds: number,
  ) {
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
  signal?: AbortSignal,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    if (signal?.aborted) {
      throw (
        signal.reason ??
        new CodexAdapterError(
          "cancellation",
          `Codex ${operation} was cancelled`,
        )
      );
    }
    const races: Promise<T>[] = [
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(
          () => reject(new CodexRequestDeadlineError(operation, milliseconds)),
          milliseconds,
        );
      }),
    ];
    if (signal !== undefined) {
      races.push(
        new Promise<T>((_, reject) => {
          onAbort = () =>
            reject(
              signal.reason ??
                new CodexAdapterError(
                  "cancellation",
                  `Codex ${operation} was cancelled`,
                ),
            );
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      );
    }
    return await Promise.race(races);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (signal !== undefined && onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
