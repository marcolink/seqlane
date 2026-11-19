import { z } from "zod";

const positiveIntegerSchema = z
  .union([
    z.number().int().positive().safe(),
    z
      .string()
      .regex(/^[1-9]\d*$/)
      .transform(Number),
  ])
  .pipe(z.number().int().positive().safe());

export const processIdentitySchema = z
  .object({
    processGroupId: positiveIntegerSchema,
    processStartTime: z.string().trim().min(1),
  })
  .strict();

export type ProcessIdentity = z.infer<typeof processIdentitySchema>;

export const processMemberSchema = z
  .object({
    pid: positiveIntegerSchema,
    identity: processIdentitySchema,
  })
  .strict();

export type ProcessMember = z.infer<typeof processMemberSchema>;

export const detachedProcessOwnershipSchema = z
  .object({
    pid: positiveIntegerSchema,
    identity: processIdentitySchema,
    sentinel: processMemberSchema.optional(),
  })
  .strict()
  .superRefine((ownership, context) => {
    if (ownership.pid !== ownership.identity.processGroupId) {
      context.addIssue({
        code: "custom",
        message: "Primary process must own its process group",
        path: ["identity", "processGroupId"],
      });
    }
    if (
      ownership.sentinel &&
      ownership.sentinel.identity.processGroupId !==
        ownership.identity.processGroupId
    ) {
      context.addIssue({
        code: "custom",
        message: "Sentinel must belong to the owned process group",
        path: ["sentinel"],
      });
    }
  });

export type DetachedProcessOwnership = z.infer<
  typeof detachedProcessOwnershipSchema
>;

export const anchorReadyMessageSchema = z
  .object({
    type: z.literal("ready"),
    sentinelPid: positiveIntegerSchema,
  })
  .strict();

export const anchorErrorMessageSchema = z
  .object({
    type: z.literal("error"),
    message: z.string(),
    sentinelPid: positiveIntegerSchema.optional(),
  })
  .strict();

export const anchorAdoptedMessageSchema = z
  .object({
    type: z.literal("adopted"),
  })
  .strict();

export const anchorMessageSchema = z.discriminatedUnion("type", [
  anchorReadyMessageSchema,
  anchorErrorMessageSchema,
  anchorAdoptedMessageSchema,
]);

export const anchorAdoptRequestSchema = z
  .object({ type: z.literal("adopt") })
  .strict();
