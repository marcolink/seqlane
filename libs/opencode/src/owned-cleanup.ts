import { Effect, Option } from "effect";
import { OpenCodeExecutorError } from "./errors.js";

const cleanupDeadlineMs = 2_000;

export async function awaitOwnedCleanup<T>(
  operation: Promise<T>,
  message: string,
  timeoutMs = cleanupDeadlineMs,
): Promise<T> {
  const result = await Effect.runPromise(
    Effect.tryPromise({
      try: () => operation,
      catch: (cause) => cause,
    }).pipe(Effect.timeoutOption(timeoutMs)),
  );
  if (Option.isNone(result)) throw new OpenCodeExecutorError(message);
  return result.value;
}
