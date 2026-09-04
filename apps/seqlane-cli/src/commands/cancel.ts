import { Args, Command, Flags } from "@oclif/core";
import { OperationalClient } from "../operational-client.js";
import { startOwnedOperationalHost } from "../operational-command-host.js";
import { workflowRootsFromFlags } from "./list.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default class CancelCommand extends Command {
  static override description =
    "Cancel one Mastra workflow run through the operational host";

  static override args = {
    "run-id": Args.string({
      description: "Mastra workflow run ID",
      required: true,
    }),
  };

  static override flags = {
    workflow: Flags.string({ description: "Registered workflow name" }),
    "server-url": Flags.string({
      description: "Existing operational server URL",
    }),
    hostname: Flags.string({
      description: "Loopback hostname for an owned operational host",
      default: "127.0.0.1",
    }),
    port: Flags.integer({
      description: "Loopback port for an owned operational host",
      default: 4111,
    }),
    "storage-url": Flags.string({
      description: "Mastra LibSQL storage URL for an owned host",
      default: "file:./.seqlane/mastra.db",
    }),
    "repository-root": Flags.string({
      description: "Repository workflow descriptor root",
    }),
    "user-root": Flags.string({ description: "User workflow descriptor root" }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(CancelCommand);
    let ownedHost:
      Awaited<ReturnType<typeof startOwnedOperationalHost>> | undefined;
    try {
      const roots = workflowRootsFromFlags(flags);
      ownedHost =
        flags["server-url"] === undefined
          ? await startOwnedOperationalHost({
              roots,
              host: flags.hostname,
              port: flags.port,
              storageUrl: flags["storage-url"],
            })
          : undefined;
      const client = new OperationalClient(
        flags["server-url"] ?? ownedHost?.address ?? "",
      );
      this.log(await client.cancelRun(args["run-id"], flags.workflow));
    } catch (error) {
      this.error(errorMessage(error));
    } finally {
      await ownedHost?.close().catch(() => undefined);
    }
  }
}
