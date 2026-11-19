import { Buffer } from "node:buffer";
import { z } from "zod";

const positiveSafeInteger = z.number().int().positive().safe();
const shortText = (max: number) => z.string().min(1).max(max);

export const ownedProcessIdentitySchema = z
  .object({
    version: z.literal(1),
    pid: positiveSafeInteger,
    processGroupId: positiveSafeInteger,
    platform: z.enum(["linux", "darwin", "win32"]),
    birthIdentity: shortText(128),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.platform !== "win32" && value.processGroupId !== value.pid) {
      context.addIssue({
        code: "custom",
        message: "POSIX owner must lead its group",
      });
    }
    if (value.platform === "win32" && value.processGroupId !== value.pid) {
      context.addIssue({
        code: "custom",
        message: "Windows tree id must equal pid",
      });
    }
  });
export type OwnedProcessIdentity = z.infer<typeof ownedProcessIdentitySchema>;

const actionSchema = z.enum(["register", "release"]);
const idSchema = shortText(128);
export const ownedProcessFrameSchema = z
  .object({
    type: z.literal("runner.owned-process"),
    action: actionSchema,
    id: idSchema,
    identity: ownedProcessIdentitySchema,
  })
  .strict();
export type OwnedProcessFrame = z.infer<typeof ownedProcessFrameSchema>;

export const ownedProcessAcknowledgementSchema = z
  .object({
    type: z.literal("runner.owned-process.ack"),
    action: actionSchema,
    id: idSchema,
    identity: ownedProcessIdentitySchema,
  })
  .strict();
export type OwnedProcessAcknowledgement = z.infer<
  typeof ownedProcessAcknowledgementSchema
>;

const MAX_FRAME_BYTES = 16 * 1024;

function encode(
  value: unknown,
  schema:
    typeof ownedProcessFrameSchema | typeof ownedProcessAcknowledgementSchema,
): string {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new TypeError("Invalid owned process frame");
  const encoded = JSON.stringify(parsed.data);
  if (Buffer.byteLength(encoded, "utf8") > MAX_FRAME_BYTES) {
    throw new RangeError("Owned process frame exceeds its byte limit");
  }
  return encoded;
}

function decode<T>(
  encoded: unknown,
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  },
): T {
  if (
    typeof encoded !== "string" ||
    Buffer.byteLength(encoded, "utf8") > MAX_FRAME_BYTES
  ) {
    throw new TypeError("Invalid owned process frame");
  }
  try {
    const value: unknown = JSON.parse(encoded);
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
  } catch {
    // Normalize malformed JSON at this private boundary.
  }
  throw new TypeError("Invalid owned process frame");
}

function isCandidate(
  value: unknown,
  type: "runner.owned-process" | "runner.owned-process.ack",
): boolean {
  let candidate = value;
  if (typeof candidate === "string") {
    if (Buffer.byteLength(candidate, "utf8") > MAX_FRAME_BYTES) return false;
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return false;
    }
  }
  const parsed = z
    .object({ type: z.literal(type) })
    .passthrough()
    .safeParse(candidate);
  return parsed.success;
}

export const encodeOwnedProcessFrame = (value: OwnedProcessFrame): string =>
  encode(value, ownedProcessFrameSchema);
export const decodeOwnedProcessFrame = (encoded: unknown): OwnedProcessFrame =>
  decode(encoded, ownedProcessFrameSchema);
export const isOwnedProcessFrameCandidate = (value: unknown): boolean =>
  isCandidate(value, "runner.owned-process");

export const encodeOwnedProcessAcknowledgement = (
  value: OwnedProcessAcknowledgement,
): string => encode(value, ownedProcessAcknowledgementSchema);
export const decodeOwnedProcessAcknowledgement = (
  encoded: unknown,
): OwnedProcessAcknowledgement =>
  decode(encoded, ownedProcessAcknowledgementSchema);
export const isOwnedProcessAcknowledgementCandidate = (
  value: unknown,
): boolean => isCandidate(value, "runner.owned-process.ack");
