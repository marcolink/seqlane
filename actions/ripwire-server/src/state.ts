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

export const CLEANUP_ONLY_STATE_KEY = "cleanup-only";
const cleanupOnlyStateSchema = z.object({
  kind: z.literal("ripwire-install-cleanup-only"),
  version: z.literal(1),
});

export type ServiceState = z.infer<typeof serviceStateSchema>;

export function serializeCleanupOnlyState(): string {
  return JSON.stringify({ kind: "ripwire-install-cleanup-only", version: 1 });
}

export function parseCleanupOnlyState(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const parsed: unknown = JSON.parse(value);
    return cleanupOnlyStateSchema.safeParse(parsed).success;
  } catch {
    return false;
  }
}

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
