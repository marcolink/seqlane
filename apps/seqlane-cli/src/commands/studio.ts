import { Command, Flags } from "@oclif/core";
import { startStudioSession } from "@seqlane/studio";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const packageRequire = createRequire(import.meta.url);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default class StudioCommand extends Command {
  static override description =
    "Start a foreground, local-only Seqlane Execution Studio";

  static override examples = [
    "<%= config.bin %> studio",
    "<%= config.bin %> studio --port 57695",
    "<%= config.bin %> studio --replay ./seqlane-recording.jsonl",
  ];

  static override flags = {
    port: Flags.integer({
      description: "Loopback port for the local Studio",
    }),
    replay: Flags.string({
      description: "Start Studio with a local Seqlane recording",
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(StudioCommand);
    let session;
    try {
      session = await startStudioSession({
        port: flags.port,
        replayFile: flags.replay,
        clientRoot: dirname(
          packageRequire.resolve(
            "@seqlane/studio-app/client/index.html",
          ),
        ),
      });
    } catch (error) {
      this.error(errorMessage(error));
    }

    this.log(`Seqlane Studio: ${session.browserUrl}`);

    await new Promise<void>((resolve) => {
      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        void session.stop().finally(resolve);
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  }
}
