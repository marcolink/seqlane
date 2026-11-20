import type { AgentRuntimeFactory } from "@seqlane/agent-adapter";
import {
  createOpenCodeAgentRuntimeFactory,
  detectOpenCodeExecutableVersion,
  detectOpenCodeServerVersion,
  startOpenCodeService,
} from "@seqlane/opencode-adapter";
import type { DirectRunAdapterConfiguration } from "./agent-runtime.js";
import { createDirectRunV2AgentRuntimeFactory } from "./opencode-v2-runtime.js";

/** Detect native protocol before acquiring a service or creating agent sessions. */
export function createDirectRunOpenCodeAgentRuntimeFactory(
  configuration: Extract<
    DirectRunAdapterConfiguration,
    { adapter: "opencode" }
  >,
  environment: Readonly<Record<string, string | undefined>>,
): AgentRuntimeFactory {
  return async (signal, workspace, factoryOptions) => {
    if (configuration.mode === "external") {
      const host = configuration.host.includes(":")
        ? `[${configuration.host}]`
        : configuration.host;
      const url = `http://${host}:${configuration.port}`;
      const authorization =
        environment.OPENCODE_SERVER_PASSWORD === undefined
          ? undefined
          : `Basic ${Buffer.from(`${environment.OPENCODE_SERVER_USERNAME ?? "opencode"}:${environment.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`;
      const version = await detectOpenCodeServerVersion({
        url,
        authorization,
        signal,
      });
      if (version === "v2")
        return createDirectRunV2AgentRuntimeFactory(
          { ...configuration, adapter: "opencode-v2" },
          environment,
        )(signal, workspace, factoryOptions);
      return createOpenCodeAgentRuntimeFactory({
        adapter: "opencode",
        url,
        authorization,
      })(signal, workspace, factoryOptions);
    }
    const version = await detectOpenCodeExecutableVersion({
      executable: configuration.executable,
      environment,
      signal,
    });
    if (version === "v2")
      return createDirectRunV2AgentRuntimeFactory(
        { ...configuration, adapter: "opencode-v2" },
        environment,
      )(signal, workspace, factoryOptions);
    const service = await startOpenCodeService({
      workspace: workspace ?? process.cwd(),
      signal,
      host: configuration.host,
      port: configuration.port,
      ...(configuration.executable === undefined
        ? {}
        : { executable: configuration.executable }),
      ...(factoryOptions?.onOwnedProcessAcquired === undefined
        ? {}
        : {
            onOwnedProcessAcquired: factoryOptions.onOwnedProcessAcquired,
          }),
    });
    try {
      const runtime = await createOpenCodeAgentRuntimeFactory({
        adapter: "opencode",
        url: service.url,
        authorization: service.authorization,
      })(signal, workspace);
      return {
        ...runtime,
        async close() {
          const results = await Promise.allSettled([
            runtime.close?.(),
            service.close(),
          ]);
          const failures = results.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
          );
          if (failures.length > 0)
            throw new AggregateError(
              failures,
              "Direct OpenCode adapter cleanup failed",
            );
        },
      };
    } catch (cause) {
      try {
        await service.close();
      } catch (cleanup) {
        throw new AggregateError(
          [cause, cleanup],
          "Direct OpenCode runtime startup and cleanup failed",
          { cause },
        );
      }
      throw cause;
    }
  };
}
