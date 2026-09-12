import { z } from "zod";

function isSafeBrowserUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  } catch {
    return false;
  }
}

const runtimeSessionUiAvailableSchema = z.strictObject({
  type: z.literal("runtime.session.ui-available"),
  invocationId: z.string().min(1),
  browserUrl: z.url().pipe(z.custom<string>(isSafeBrowserUrl)),
});

export type RuntimeSessionUiAvailable = Readonly<
  z.output<typeof runtimeSessionUiAvailableSchema>
>;

export function encodeRuntimeSessionUiAvailable(
  message: RuntimeSessionUiAvailable,
): string {
  const parsed = runtimeSessionUiAvailableSchema.safeParse(message);
  if (!parsed.success)
    throw new TypeError("Invalid runtime session UI message");

  try {
    const encoded = JSON.stringify(parsed.data);
    if (encoded === undefined) throw new TypeError();
    return encoded;
  } catch {
    throw new TypeError("Invalid runtime session UI message");
  }
}

export function decodeRuntimeSessionUiAvailable(
  encoded: string,
): RuntimeSessionUiAvailable {
  if (typeof encoded !== "string") {
    throw new TypeError("Invalid runtime session UI message");
  }

  try {
    const decoded: unknown = JSON.parse(encoded);
    const parsed = runtimeSessionUiAvailableSchema.safeParse(decoded);
    if (parsed.success) return parsed.data;
  } catch {
    // Normalize parser and validation failures at the IPC boundary.
  }

  throw new TypeError("Invalid runtime session UI message");
}
