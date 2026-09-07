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

export interface AcpAgentStream {
  readonly fullStream: ReadableStream<unknown>;
  readonly text: Promise<string>;
}

export interface AcpAgent {
  stream(
    messages: { readonly role: "user"; readonly content: string }[],
    options: { readonly abortSignal?: AbortSignal; readonly runId?: string },
  ): Promise<AcpAgentStream>;
}

export interface AcpAgentFactoryOptions extends AcpLaunchConfiguration {
  readonly onPermissionRequest?: (
    request: unknown,
  ) => Promise<{ readonly outcome: { readonly outcome: "cancelled" } }>;
}

export type AcpAgentFactory = (options: AcpAgentFactoryOptions) => AcpAgent;

export interface AcpExecutorOptions {
  /** Number of local structured-output repair attempts. */
  readonly structuredOutputRetryCount?: number;
  /** Private test seam for a controlled ACP implementation. */
  readonly createAgent?: AcpAgentFactory;
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
