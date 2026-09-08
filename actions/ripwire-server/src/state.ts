import { z } from "zod";

const processIdentitySchema = z.object({
  processGroupId: z.number().int().positive(),
  processStartTime: z.string().min(1),
});

export const serviceStateSchema = z.object({
  pid: z.number().int().positive(),
  identity: processIdentitySchema,
  sentinel: z.object({
    pid: z.number().int().positive(),
    identity: processIdentitySchema,
  }),
});

export type ServiceState = z.infer<typeof serviceStateSchema>;

export function serializeServiceState(state: ServiceState): string {
  return JSON.stringify(state);
}

export function parseServiceState(
  value: string | undefined,
): ServiceState | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    const result = serviceStateSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}
