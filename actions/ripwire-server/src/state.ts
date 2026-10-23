import { z } from "zod";
import { detachedProcessOwnershipSchema } from "@seqlane/action-service-lifecycle";

export const serviceStateSchema = detachedProcessOwnershipSchema;

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
