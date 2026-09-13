import { Args, Command, Flags } from "@oclif/core";
import type { ExecutionEventConsumer } from "../event-dispatcher.js";
import { createEventDispatcher } from "../event-dispatcher.js";
import { readSeqlaneRecording } from "../recording.js";
import {
  connectTerminalResize,
  createCliRenderer,
  createOutputCapabilities,
} from "../output.js";
import { parseOutputMode } from "../output-mode.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default class ReplayCommand extends Command {
  static override description =
    "Replay a local canonical execution recording without executing a workflow";

  static override examples = [
    "<%= config.bin %> replay ./seqlane-recording.jsonl --output human",
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
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ReplayCommand);
    let recording;
    try {
      recording = readSeqlaneRecording(args.recording);
    } catch (error) {
      this.error(`Could not read recording: ${errorMessage(error)}`);
    }

    const capabilities = createOutputCapabilities();
    const { renderer } = createCliRenderer(
      parseOutputMode(flags.output),
      capabilities,
    );
    const disconnectResize = connectTerminalResize(renderer, process.stdout);
    const outputConsumer: ExecutionEventConsumer = {
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
      [{ name: "output", consumer: outputConsumer }],
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
  }
}
