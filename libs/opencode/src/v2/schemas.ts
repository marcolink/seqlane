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
export const toolSchema = z.object({
  type: z.literal("tool"),
  id: identity,
  name: z.string().min(1).max(256),
  state: z.object({
    status: z.enum(["streaming", "running", "completed", "error"]),
    input: z.record(z.string(), z.unknown()).optional(),
    content: z.array(z.unknown()).max(256).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
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
        z.object({ type: z.literal("reasoning") }),
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
