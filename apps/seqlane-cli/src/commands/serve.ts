import { Command, Flags } from "@oclif/core";
import {
  loadRuntimeAdapterConfiguration,
  runtimeAdapterConfigurationEnvironment,
} from "@seqlane/runtime/operational-host";
import { startOwnedOperationalHost } from "../operational-command-host.js";
import { workflowRootsFromFlags } from "../workflow-roots.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default class ServeCommand extends Command {
  static override description =
    "Run the foreground Mastra operational host for discovered workflows";

  static override examples = [
    "<%= config.bin %> serve",
    "<%= config.bin %> serve --port 4112 --storage-url file:./.seqlane/mastra.db",
  ];

  static override flags = {
    hostname: Flags.string({
      description: "Loopback hostname for the operational host",
      default: "127.0.0.1",
    }),
    port: Flags.integer({
      description: "Loopback port for the operational host",
      default: 4111,
    }),
    "storage-url": Flags.string({
      description: "Mastra LibSQL storage URL",
      default: "file:./.seqlane/mastra.db",
    }),
    "repository-root": Flags.string({
      description: "Repository workflow descriptor root",
    }),
    "user-root": Flags.string({
      description: "User workflow descriptor root",
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ServeCommand);
    let operationalHost: Awaited<ReturnType<typeof startOwnedOperationalHost>>;
    try {
      const roots = workflowRootsFromFlags(flags);
      const adapterConfiguration =
        process.env[runtimeAdapterConfigurationEnvironment] === undefined
          ? undefined
          : loadRuntimeAdapterConfiguration();
      operationalHost = await startOwnedOperationalHost({
        roots,
        host: flags.hostname,
        port: flags.port,
        storageUrl: flags["storage-url"],
        adapterConfiguration,
      });
    } catch (error) {
      this.error(
        `Could not initialize Seqlane operational host: ${errorMessage(error)}`,
      );
    }

    const signals = ["SIGINT", "SIGTERM"] as const;
    let stopping = false;
    const stop = async (): Promise<void> => {
      if (stopping) return;
      stopping = true;
      await operationalHost.close();
    };
    let onSignal: (() => void) | undefined;

    try {
      const address = await operationalHost.listen();
      this.log(`Seqlane operational host: ${address}`);
      this.log(`Seqlane readiness: ${address}/readyz`);
      await new Promise<void>((resolve, reject) => {
        onSignal = () => {
          void stop().then(resolve, reject);
        };
        for (const signal of signals) process.once(signal, onSignal);
      });
    } catch (error) {
      await stop().catch(() => undefined);
      this.error(`Seqlane operational host failed: ${errorMessage(error)}`);
    } finally {
      if (onSignal) {
        for (const signal of signals) process.removeListener(signal, onSignal);
      }
    }
  }
}
