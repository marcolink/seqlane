export async function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let rejectAbort!: (cause: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => rejectAbort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const result = await Promise.race([promise, aborted]);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
