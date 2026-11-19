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
  /** Whether one ACP session is reused by this adapter. */
  persistSession: z.boolean(),
  /** An ACP model config-option value advertised by the agent. */
  model: z.string().min(1).optional(),
});

export type AcpLaunchConfiguration = z.output<
  typeof acpLaunchConfigurationSchema
>;

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
