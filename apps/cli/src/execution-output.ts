/**
 * Prevent workflow module and task output from corrupting the CLI's JSON
 * result. The CLI is the only writer to stdout while this boundary is active.
 */
export async function withExecutionOutputBoundary<T>(
  enabled: boolean,
  execute: () => Promise<T>,
  writeDiagnostic: (value: string) => void,
): Promise<T> {
  if (!enabled) return execute();

  const write = process.stdout.write;
  // This narrow platform cast intercepts arbitrary workflow console output.
  process.stdout.write = ((chunk: string | Uint8Array) => {
    const value = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
    writeDiagnostic(value);
    return true;
  }) as typeof process.stdout.write;
  try {
    return await execute();
  } finally {
    process.stdout.write = write;
  }
}
