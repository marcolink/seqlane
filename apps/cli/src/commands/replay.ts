import { Args, Flags } from "@oclif/core";
import { readSeqlaneRecording } from "../recording.js";
import { createCliRenderer, createOutputCapabilities } from "../output.js";
import { outputModeOptions, parseOutputMode } from "../output-mode.js";
import {
  contextualizeCommandError,
  errorMessage,
  SeqlaneCommand,
} from "../command.js";
import { renderReplayRecording, writeReplayEvents } from "../replay.js";

export default class ReplayCommand extends SeqlaneCommand {
  static override description =
    "Replay a local canonical execution recording without executing a workflow";

  static override examples = [
    "<%= config.bin %> replay ./seqlane-recording.jsonl --output human",
    "<%= config.bin %> replay ./seqlane-recording.jsonl --events ndjson",
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
      options: outputModeOptions,
      default: "auto",
      exclusive: ["events"],
    }),
    events: Flags.string({
      description: "Replay canonical events as newline-delimited JSON",
      options: ["ndjson"],
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ReplayCommand);
    const outputWasExplicit = this.argv.some(
      (argument) => argument === "--output" || argument.startsWith("--output="),
    );
    if (flags.events !== undefined && outputWasExplicit) {
      this.error("--events and --output cannot be used together");
    }

    if (flags.events === "ndjson") {
      try {
        writeReplayEvents(
          args.recording,
          process.stdout,
          createOutputCapabilities().redactions,
        );
      } catch (error) {
        this.error(
          contextualizeCommandError(
            `Could not replay recording: ${errorMessage(error)}`,
            error,
          ),
          { exit: 1 },
        );
      }
      return;
    }

    let recording;
    try {
      recording = readSeqlaneRecording(args.recording);
    } catch (error) {
      this.error(
        contextualizeCommandError(
          `Could not read recording: ${errorMessage(error)}`,
          error,
        ),
        { exit: 1 },
      );
    }

    const capabilities = createOutputCapabilities();
    const { renderer } = createCliRenderer(
      parseOutputMode(flags.output),
      capabilities,
    );
    await renderReplayRecording({
      recording,
      renderer,
      capabilities,
    });
  }
}
