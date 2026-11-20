import { z } from "zod";

const identity = z.string().min(1).max(512);
const time = z.number().finite().nonnegative();
const nativeModelSchema = z.object({
  providerID: identity,
  id: identity,
  variant: identity.optional(),
});
export const serverInfoSchema = z.object({
  version: identity,
  pid: z.number().int().nonnegative(),
  urls: z.array(z.url()).max(32),
});
export const sessionSchema = z.object({
  id: identity,
  parentID: identity.optional(),
  fork: z
    .object({
      sessionID: identity,
      boundary: z.object({
        type: z.enum(["before", "through"]),
        messageID: identity,
      }),
    })
    .optional(),
  location: z.object({ directory: z.string().min(1) }),
  model: nativeModelSchema.optional(),
  outcome: z.enum(["succeeded", "failed", "interrupted"]).optional(),
});
export const admissionSchema = z.object({
  id: identity,
  sessionID: identity,
  type: z.literal("user"),
});
export const tokensSchema = z.object({
  input: time,
  output: time,
  reasoning: time,
  cache: z.object({ read: time, write: time }),
});
// Bound opaque native values before recursive serialization and redaction.
const observationValueSchema = z.unknown().superRefine((value, context) => {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    if (++nodes > 65_536 || current.depth > 64) {
      context.addIssue({
        code: "custom",
        message: "Native observation value exceeds the depth or node limit",
      });
      return;
    }
    if (typeof current.value !== "object" || current.value === null) continue;
    for (const descriptor of Object.values(
      Object.getOwnPropertyDescriptors(current.value),
    )) {
      if ("value" in descriptor)
        pending.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }
});
export const toolSchema = z.object({
  type: z.literal("tool"),
  id: identity,
  name: z.string().min(1).max(256),
  state: z.object({
    status: z.enum(["streaming", "running", "completed", "error"]),
    input: observationValueSchema
      .pipe(z.record(z.string(), z.unknown()))
      .optional(),
    content: observationValueSchema
      .pipe(z.array(z.unknown()).max(256))
      .optional(),
    metadata: observationValueSchema
      .pipe(z.record(z.string(), z.unknown()))
      .optional(),
  }),
  time: z.object({ created: time, completed: time.optional() }),
});
const assistantSchema = z.object({
  type: z.literal("assistant"),
  id: identity,
  time: z.object({ created: time, completed: time.optional() }),
  model: nativeModelSchema,
  cost: time.optional(),
  tokens: tokensSchema.optional(),
  error: z.unknown().optional(),
  content: z
    .array(
      z.union([
        z.object({ type: z.literal("text"), text: z.string().max(1_048_576) }),
        z.object({
          type: z.literal("reasoning"),
          text: z.string().max(1_048_576).optional(),
          time: z
            .object({ created: time, completed: time.optional() })
            .optional(),
        }),
        toolSchema,
      ]),
    )
    .max(1024),
});
const markerSchema = z.object({
  id: identity,
  type: z.enum([
    "user",
    "idle",
    "system",
    "synthetic",
    "skill",
    "shell",
    "compaction",
    "agent-switched",
    "model-switched",
    "location-switched",
  ]),
  outcome: z.enum(["succeeded", "failed", "interrupted"]).optional(),
});
export const messageSchema = z.union([assistantSchema, markerSchema]);
export type NativeMessage = z.infer<typeof messageSchema>;
export type NativeAssistant = z.infer<typeof assistantSchema>;
export type NativeTool = z.infer<typeof toolSchema>;
export const cursorSchema = z.object({
  next: z.string().min(1).max(4096).nullish(),
});
export const messagePageSchema = z.object({
  data: z.array(messageSchema).max(100),
  cursor: cursorSchema,
});
export const sessionPageSchema = z.object({
  data: z.array(sessionSchema).max(100),
  cursor: cursorSchema,
});
export const pendingSchema = z.array(z.object({ id: identity })).max(1024);
export const questionFormIdentitySchema = z.object({
  id: identity,
  sessionID: identity,
});
const questionKeySchema = z.string().regex(/^q[0-7]$/);
const questionFieldSchema = z.strictObject({
  key: questionKeySchema,
  title: z.string().max(4096),
  description: z.string().max(4096).optional(),
  type: z.literal("string"),
  required: z.boolean().optional(),
  custom: z.boolean().optional(),
  options: z
    .array(
      z.strictObject({
        value: z.string().min(1).max(8192),
        label: z.string().min(1).max(256),
        description: z.string().max(256).optional(),
      }),
    )
    .max(20)
    .optional(),
});
export const questionFormSchema = questionFormIdentitySchema
  .extend({
    title: z.string().max(4096),
    metadata: z.object({ kind: z.literal("question") }),
    fields: z.array(questionFieldSchema).min(1).max(8),
  })
  .superRefine((form, context) => {
    for (const [index, field] of form.fields.entries()) {
      if (field.key !== `q${index}`)
        context.addIssue({
          code: "custom",
          message: "Question keys must follow native question order",
        });
      const values = field.options?.map(({ value }) => value) ?? [];
      if (new Set(values).size !== values.length)
        context.addIssue({
          code: "custom",
          message: "Question option values must be unique",
        });
      if (field.options?.length === 0 && field.custom !== true)
        context.addIssue({
          code: "custom",
          message: "An empty option list must allow custom answers",
        });
    }
  });
export const questionFormListSchema = z
  .array(questionFormIdentitySchema.passthrough())
  .max(1024);
export const questionFormDetailSchema = questionFormSchema.safeExtend({
  state: z.object({ status: z.enum(["pending", "answered", "cancelled"]) }),
});
export type NativeQuestionForm = z.infer<typeof questionFormSchema>;
export const questionFormAnswerSchema = z.record(
  questionKeySchema,
  z.string().min(1).max(8192),
);
export const activeSchema = z.record(z.string(), z.unknown());
export const shellPageSchema = z.object({
  data: z
    .array(
      z.object({
        id: identity,
        status: z.enum(["running", "exited", "timeout", "killed"]),
        metadata: z.record(z.string(), z.unknown()),
      }),
    )
    .max(1024),
});
export const modelSchema = z.object({
  providerID: identity,
  id: identity,
  enabled: z.boolean(),
  capabilities: z.object({ tools: z.boolean() }),
  variants: z.array(z.object({ id: identity })).max(128),
});
export const modelPageSchema = z.object({
  data: z.array(modelSchema).max(20_000),
});
export const defaultModelSchema = z.object({ data: modelSchema.nullable() });
