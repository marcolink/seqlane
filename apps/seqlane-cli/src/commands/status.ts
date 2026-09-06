import { Args, Command, Flags } from "@oclif/core";
import { OperationalClient } from "../operational-client.js";
import { startOwnedOperationalHost } from "../operational-command-host.js";
import { workflowRootsFromFlags } from "../workflow-roots.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default class StatusCommand extends Command {
  static override description =
    "Inspect one canonical Mastra workflow run through the operational host";

  static override args = {
    "run-id": Args.string({
      description: "Mastra workflow run ID",
      required: true,
    }),
  };

  static override flags = {
    output: Flags.string({
      description: "Status output mode",
      options: ["human", "json"],
      default: "human",
    }),
    workflow: Flags.string({
      description: "Registered workflow name when the run ID is not unique",
    }),
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
    const { args, flags } = await this.parse(StatusCommand);
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
      const run = await client.getRun(args["run-id"], flags.workflow);
      this.log(
        flags.output === "json"
          ? JSON.stringify(run, null, 2)
          : [
              `run: ${run.runId}`,
              `workflow: ${run.workflowName ?? "unknown"}`,
              `status: ${run.status}`,
              ...(run.resourceId === undefined
                ? []
                : [`work: ${run.resourceId}`]),
            ].join("\n"),
      );
    } catch (error) {
      this.error(errorMessage(error));
    } finally {
      await ownedHost?.close().catch(() => undefined);
    }
  }
}
