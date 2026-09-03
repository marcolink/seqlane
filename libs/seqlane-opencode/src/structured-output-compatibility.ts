function errorText(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value !== "object" || value === null) return String(value);
  const record = value as Record<string, unknown>;
  const data = record.data;
  const error = record.error;
  const messages = [
    record.message,
    typeof data === "object" && data !== null
      ? (data as Record<string, unknown>).message
      : undefined,
    typeof error === "object" && error !== null
      ? (error as Record<string, unknown>).message
      : undefined,
  ];
  return messages
    .filter((message): message is string => typeof message === "string")
    .join(" ");
}

export function isNativeReadbackCompatibilityError(value: unknown): boolean {
  const text = errorText(value);
  return (
    /Expected OutputFormat(?:JsonSchema|Text)/.test(text) &&
    /\["info"\]\["format"\]\s*$/.test(text)
  );
}
