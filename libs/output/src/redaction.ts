export function redactOutput(
  value: string,
  redactions: readonly string[],
): string {
  return [...new Set(redactions)]
    .filter((secret) => secret.length >= 4)
    .sort((left, right) => right.length - left.length)
    .reduce((redacted, secret) => redacted.split(secret).join("***"), value);
}
