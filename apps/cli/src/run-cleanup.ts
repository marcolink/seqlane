/** Attempts each owned-resource cleanup without replacing the primary outcome. */
export async function closeOwnedResources(
  operations: readonly (() => void | Promise<void>)[],
): Promise<readonly unknown[]> {
  const errors: unknown[] = [];
  for (const operation of operations) {
    try {
      await operation();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}
