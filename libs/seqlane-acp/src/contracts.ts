import type { SeqlaneInvocationMetrics } from "@seqlane/core";
import { z } from "zod";
import { AcpAdapterError } from "./errors.js";

/** Validated configuration for one ACP process and its owned session. */
export const acpLaunchConfigurationSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().min(1).optional(),
  /** Mastra ACP defaults this to true, so the adapter requires it explicitly. */
  persistSession: z.boolean(),
  /** An ACP model identifier. The adapter does not derive or format it. */
  model: z.string().min(1).optional(),
});

export type AcpLaunchConfiguration = z.output<
  typeof acpLaunchConfigurationSchema
>;

export type AcpActivityState = "started" | "progress" | "succeeded" | "failed";

export interface AcpActivity {
  readonly activityId: string;
  readonly kind: "tool";
  readonly name: string;
  readonly state: AcpActivityState;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly message?: string;
}

export interface AcpExecutorRequest {
  readonly invocationId: string;
  readonly taskId: string;
  readonly input: unknown;
  readonly signal: AbortSignal;
  readonly onMetrics?: (metrics: SeqlaneInvocationMetrics) => void;
  readonly onDiagnostic?: (diagnostic: AcpDiagnostic) => void;
  readonly onActivity?: (activity: AcpActivity) => void;
}

export interface AcpExecutor {
  execute(request: AcpExecutorRequest): Promise<unknown>;
}

export interface AcpDiagnostic {
  readonly code: "structured-output";
  readonly message: string;
}

export interface AcpExecutorOptions {
  /** Number of local structured-output repair attempts. */
  readonly structuredOutputRetryCount?: number;
}

export function parseAcpLaunchConfiguration(
  value: unknown,
): AcpLaunchConfiguration {
  try {
    return acpLaunchConfigurationSchema.parse(value);
  } catch (cause) {
    throw new AcpAdapterError(
      "configuration",
      "invalid launch configuration",
      cause,
    );
  }
}
