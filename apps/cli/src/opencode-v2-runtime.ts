import {
  createOpenCodeV2AgentRuntimeFactory,
  startOpenCodeV2Service,
  loopbackHostSchema as v2HostSchema,
} from "@seqlane/opencode-v2-adapter";
import type { AgentRuntimeFactory } from "@seqlane/agent-adapter";
import { isAbsolute } from "node:path";
import { z } from "zod";
export const directRunV2ConfigurationSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    adapter: z.literal("opencode-v2"),
    mode: z.literal("managed"),
    host: v2HostSchema.default("127.0.0.1"),
    port: z.number().int().min(0).max(65535).default(0),
    executable: z
      .string()
      .min(1)
      .pipe(
        z.custom<string>(
          (value) => typeof value === "string" && isAbsolute(value),
          "must be an absolute executable path",
        ),
      )
      .optional(),
  }),
  z.strictObject({
    adapter: z.literal("opencode-v2"),
    mode: z.literal("external"),
    host: v2HostSchema,
    port: z.number().int().min(1).max(65535),
  }),
]);

/** CLI-owned service acquisition; V2 native details stay out of runner IPC. */
export function createDirectRunV2AgentRuntimeFactory(
  configuration: z.output<typeof directRunV2ConfigurationSchema>,
  environment: Readonly<Record<string, string | undefined>>,
): AgentRuntimeFactory {
  if (configuration.mode === "external") {
    const password = environment.OPENCODE_SERVER_PASSWORD;
    const host = configuration.host.includes(":")
      ? `[${configuration.host}]`
      : configuration.host;
    return createOpenCodeV2AgentRuntimeFactory({
      adapter: "opencode-v2",
      url: `http://${host}:${configuration.port}`,
      ...(password === undefined
        ? {}
        : {
            authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
          }),
    });
  }
  return async (signal, workspace, factoryOptions) => {
    const service = await startOpenCodeV2Service({
      workspace: workspace ?? process.cwd(),
      signal,
      environment,
      host: configuration.host,
      port: configuration.port,
      ...(factoryOptions?.onOwnedProcessAcquired === undefined
        ? {}
        : { onOwnedProcessAcquired: factoryOptions.onOwnedProcessAcquired }),
      ...(configuration.executable === undefined
        ? {}
        : { executable: configuration.executable }),
    });
    try {
      const runtime = await createOpenCodeV2AgentRuntimeFactory({
        adapter: "opencode-v2",
        url: service.url,
        authorization: service.authorization,
      })(signal, workspace);
      return {
        ...runtime,
        async close() {
          const failures: unknown[] = [];
          try {
            await runtime.close?.();
          } catch (cause) {
            failures.push(cause);
          }
          try {
            await service.close();
          } catch (cause) {
            failures.push(cause);
          }
          if (failures.length > 0)
            throw new AggregateError(failures, "OpenCode V2 cleanup failed");
        },
      };
    } catch (cause) {
      try {
        await service.close();
      } catch (cleanup) {
        throw new AggregateError(
          [cause, cleanup],
          "OpenCode V2 acquisition and cleanup failed",
        );
      }
      throw cause;
    }
  };
}
