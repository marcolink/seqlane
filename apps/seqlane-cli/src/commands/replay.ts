import { Args, Command, Flags } from "@oclif/core";
import type { SeqlaneExecutionEventConsumer } from "@seqlane/events";
import { defaultStudioPort, startStudioSession } from "@seqlane/studio";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { createEventDispatcher } from "../event-dispatcher.js";
import { readSeqlaneRecording } from "../recording.js";
import { createStudioPublisher } from "../studio-publisher.js";
import {
  connectTerminalResize,
  createCliRenderer,
  createOutputCapabilities,
} from "../output.js";
import { parseOutputMode } from "../output-mode.js";

const packageRequire = createRequire(import.meta.url);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default class ReplayCommand extends Command {
  static override description =
    "Replay a local canonical execution recording without executing a workflow";

  static override examples = [
    "<%= config.bin %> replay ./seqlane-recording.jsonl --output human",
    "<%= config.bin %> replay ./seqlane-recording.jsonl --studio",
  ];

  static override args = {
    recording: Args.string({
      description: "Path to a Seqlane recording",
      required: true,
    }),
  };

  static override flags = {
    output: Flags.string({
      description: "Replay output mode",
      options: ["auto", "human", "ci", "json"],
      default: "auto",
    }),
    studio: Flags.boolean({
      description: "Use the local Studio",
    }),
    studioPort: Flags.integer({
      description: "Loopback port for the local Studio",
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ReplayCommand);
    let recording;
    try {
      recording = readSeqlaneRecording(args.recording);
    } catch (error) {
      this.error(`Could not read recording: ${errorMessage(error)}`);
    }

    let studioAddress: string | undefined;
    let ownedStudio: Awaited<ReturnType<typeof startStudioSession>> | undefined;
    if (flags.studio) {
      const port = flags.studioPort ?? defaultStudioPort;
      studioAddress = `http://127.0.0.1:${port}`;
      try {
        const health = await fetch(`${studioAddress}/health`);
        if (!health.ok) {
          throw new Error(`Studio returned HTTP ${health.status}`);
        }
      } catch {
        ownedStudio = await startStudioSession({
          port,
          clientRoot: dirname(
            packageRequire.resolve("@seqlane/studio-app/client/index.html"),
          ),
        });
        studioAddress = ownedStudio.address;
      }
    }

    const capabilities = createOutputCapabilities();
    if (studioAddress !== undefined) {
      capabilities.stderr.write(`Seqlane Studio: ${studioAddress}/\n`);
    }
    const { renderer } = createCliRenderer(
      parseOutputMode(flags.output),
      capabilities,
    );
    const disconnectResize = connectTerminalResize(renderer, process.stdout);
    const studioPublisher =
      studioAddress === undefined
        ? undefined
        : createStudioPublisher(studioAddress, recording.header.workflowId, {
            onDiagnostic: (message) =>
              capabilities.stderr.write(message + "\n"),
          });
    const outputConsumer: SeqlaneExecutionEventConsumer = {
      consume: (event) => {
        try {
          renderer.handle(event);
        } catch (error) {
          capabilities.stderr.write(
            "seqlane output error: " + errorMessage(error) + "\n",
          );
        }
      },
      flush: async () => undefined,
      close: async () => undefined,
    };
    const dispatcher = createEventDispatcher(
      [
        { name: "output", consumer: outputConsumer },
        ...(studioPublisher === undefined
          ? []
          : [{ name: "Studio", consumer: studioPublisher }]),
      ],
      {
        maxQueueSize: recording.events.length,
        onDiagnostic: (message) => capabilities.stderr.write(message + "\n"),
      },
    );

    for (const event of recording.events) dispatcher.consume(event);
    await dispatcher.flush();
    await dispatcher.close();
    try {
      await renderer.finish();
    } catch (error) {
      capabilities.stderr.write(
        "seqlane output error: " + errorMessage(error) + "\n",
      );
    } finally {
      disconnectResize();
    }
    await ownedStudio?.stop();
  }
}
