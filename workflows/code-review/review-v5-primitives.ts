import { z } from "zod";

export const REVIEW_STATE_VERSION = 5;
export const reviewDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const reviewDecimalIdSchema = z
  .string()
  .regex(/^[1-9]\d{0,127}$/, { abort: true });
export const reviewCommitIdSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const reviewPositiveIntegerSchema = z
  .number()
  .int()
  .positive({ abort: true })
  .safe();
export const reviewGenerationSchema = z.string().regex(/^[0-9a-f]{32}$/);

export function reviewUtf8StringSchema(maxBytes: number) {
  return z
    .string()
    .min(1, { abort: true })
    .max(maxBytes, { abort: true })
    .superRefine((value, ctx) => {
      const bytes = new TextEncoder().encode(value);
      if (
        bytes.byteLength > maxBytes ||
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          bytes,
        ) !== value
      ) {
        ctx.addIssue({
          code: "custom",
          message: "String exceeds its UTF-8 bound or contains invalid Unicode",
        });
      }
    });
}

export const reviewCanonicalPathSchema = reviewUtf8StringSchema(
  512,
).superRefine((path, ctx) => {
  if (
    path.includes("\0") ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    /^[A-Za-z]:[/\\]/.test(path) ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    ctx.addIssue({ code: "custom", message: "Invalid canonical Git path" });
  }
});
export const reviewSanitizedTextSchema = reviewUtf8StringSchema(
  2_000,
).superRefine((text, ctx) => {
  if (
    [...text].some((character) => {
      const code = character.charCodeAt(0);
      return (
        (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127
      );
    })
  )
    ctx.addIssue({
      code: "custom",
      message: "Persisted text contains unsafe control characters",
    });
});
export const reviewV5FindingIdSchema = reviewUtf8StringSchema(128).regex(
  /^SEQ-PR[1-9]\d*-G[0-9a-f]{32}-\d{3,}$/,
  { abort: true },
);
export const reviewFindingIdPartsSchema = reviewV5FindingIdSchema.transform(
  (id) => {
    const parts = z
      .tuple([
        z.literal("SEQ"),
        z.string().regex(/^PR[1-9]\d*$/),
        z.string().regex(/^G[0-9a-f]{32}$/),
        z.string().regex(/^\d{3,}$/),
      ])
      .parse(id.split("-"));
    return {
      pullRequestNumber: parts[1].slice(2),
      generation: parts[2].slice(1),
      index: BigInt(parts[3]),
    };
  },
);
