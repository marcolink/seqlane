import { Args, Command, Flags } from "@oclif/core";
import { isJsonValue, type JsonValue, type RunRequest } from "@seqlane/core";
import type { SeqlaneExecutionEventConsumer } from "@seqlane/events";
import { resolve } from "node:path";
import { closeSync, openSync, readSync } from "node:fs";
import { launchRunner } from "../runner-client.js";
import { createEventDispatcher } from "../event-dispatcher.js";
import { createRecordingConsumer } from "../recording.js";
import {
  connectTerminalResize,
  createCliRenderer,
  createOutputCapabilities,
} from "../output.js";
import { parseOutputMode } from "../output-mode.js";
import { workflowRootsFromFlags } from "../workflow-roots.js";
import {
  discoverWorkflowDescriptors,
  resolveWorkflowSelection,
  type WorkflowRoots,
} from "../workflow-discovery.js";
import { isExplicitWorkflowReference } from "../workflow-reference.js";

const localRuntimeId = "local";
const MAX_INPUT_FILE_BYTES = 1_048_576;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseJsonInput(value: string): JsonValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("--input must be valid JSON");
  }

  if (!isJsonValue(parsed)) throw new Error("--input must be a JSON value");
  return parsed;
}

function readJsonInput(
  inlineInput: string | undefined,
  inputFile: string | undefined,
): string {
  if ((inlineInput === undefined) === (inputFile === undefined)) {
    throw new Error("specify exactly one of --input or --input-file");
  }
  if (inlineInput !== undefined) return inlineInput;
  if (inputFile === undefined) {
    throw new Error("specify exactly one of --input or --input-file");
  }

  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = openSync(resolve(inputFile), "r");
    const buffer = Buffer.allocUnsafe(MAX_INPUT_FILE_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = readSync(
        fileDescriptor,
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (result === 0) break;
      bytesRead += result;
    }
    if (bytesRead > MAX_INPUT_FILE_BYTES) {
      throw new Error(`file exceeds the ${MAX_INPUT_FILE_BYTES}-byte limit`);
    }
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch (error) {
    throw new Error(`--input-file could not be read: ${errorMessage(error)}`, {
      cause: error,
    });
  } finally {
    if (fileDescriptor !== undefined) closeSync(fileDescriptor);
  }
}

export function createRunRequest(
  workflow: string,
  input: string,
  runtime: string | undefined,
  workspace: string | undefined,
  dryRun: boolean,
  roots: WorkflowRoots,
): RunRequest {
  const workflows = isExplicitWorkflowReference(workflow)
    ? []
    : discoverWorkflowDescriptors(roots);
  return {
    type: "run.start",
    workflow: resolveWorkflowSelection(workflow, workflows).reference,
    input: parseJsonInput(input),
    runtime: {
      id: runtime ?? localRuntimeId,
      ...(workspace === undefined ? {} : { workspace }),
    },
    ...(dryRun ? { dryRun: true } : {}),
  };
}

export default class RunCommand extends Command {
  static override description = "Run one selected workflow in a fresh runner";

  static override examples = [
    '<%= config.bin %> run ./examples/minimal-workflow.ts --input \'{"topic":"Seqlane"}\' --runtime local',
    '<%= config.bin %> run repository:review --input \'{"topic":"Seqlane"}\'',
  ];

  static override args = {
    workflow: Args.string({
      description:
        "qualified or unique workflow name, or direct file/module reference",
      required: true,
    }),
  };

  static override flags = {
    input: Flags.string({
      char: "i",
      description: "JSON workflow input",
    }),
    "input-file": Flags.string({
      description: "Path to a JSON workflow input file (maximum 1 MiB)",
    }),
    runtime: Flags.string({
      description: "Generic runtime profile identifier",
    }),
    workspace: Flags.string({
      description: "Workspace path for file-accessing tasks",
    }),
    output: Flags.string({
      description: "Execution output mode",
      options: ["auto", "human", "ci", "json"],
      default: "auto",
    }),
    record: Flags.string({
      description: "Write bounded canonical execution events to a new file",
    }),
    dry: Flags.boolean({
      description: "Print the calculated Plan without executing workflow tasks",
    }),
    "repository-root": Flags.string({
      description: "Repository workflow descriptor root",
    }),
    "user-root": Flags.string({
      description: "User workflow descriptor root",
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(RunCommand);
    let request: RunRequest;

    try {
      request = createRunRequest(
        args.workflow,
        readJsonInput(flags.input, flags["input-file"]),
        flags.runtime,
        flags.workspace,
        flags.dry,
        workflowRootsFromFlags(flags),
      );
    } catch (error) {
      this.error(errorMessage(error));
    }

    const capabilities = createOutputCapabilities();
    const renderer = flags.dry
      ? undefined
      : createCliRenderer(parseOutputMode(flags.output), capabilities).renderer;
    const disconnectResize =
      renderer === undefined
        ? () => undefined
        : connectTerminalResize(renderer, process.stdout);
    let recordingConsumer: SeqlaneExecutionEventConsumer | undefined;
    if (flags.record !== undefined) {
      try {
        recordingConsumer = createRecordingConsumer(
          flags.record,
          request.workflow.id,
        );
      } catch (error) {
        this.error(`Could not create recording: ${errorMessage(error)}`);
      }
      capabilities.stderr.write(
        `Seqlane recording: bounded execution data is written to disk at ${flags.record}\n`,
      );
    }
    const outputConsumer: SeqlaneExecutionEventConsumer = {
      consume: (event) => {
        try {
          if (flags.dry) {
            if (event.type === "run.plan") {
              capabilities.stdout.write(
                JSON.stringify(event.plan, null, 2) + "\n",
              );
            }
            return;
          }
          renderer?.handle(event);
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
        ...(recordingConsumer === undefined
          ? []
          : [{ name: "recording", consumer: recordingConsumer }]),
      ],
      {
        onDiagnostic: (message) => capabilities.stderr.write(message + "\n"),
      },
    );
    const client = launchRunner(request, {
      onExecutionEvent: (event) => dispatcher.consume(event),
      onRuntimeSessionUiAvailable: (notification) => {
        if (renderer?.handleRuntimeSessionUi !== undefined) {
          renderer.handleRuntimeSessionUi(notification);
          return;
        }
        capabilities.stderr.write(
          `Seqlane session UI: ${notification.browserUrl}\n`,
        );
      },
    });
    const result = await client.result;
    await dispatcher.flush();
    await dispatcher.close();
    if ("failure" in result) {
      if (renderer?.handleRunnerFailure !== undefined) {
        renderer.handleRunnerFailure(result.failure);
      } else {
        capabilities.stderr.write(
          "seqlane runner error: " + result.failure.message + "\n",
        );
      }
    }
    try {
      await renderer?.finish();
    } catch (error) {
      capabilities.stderr.write(
        "seqlane output error: " + errorMessage(error) + "\n",
      );
    } finally {
      disconnectResize();
    }
    process.exitCode = result.status;
  }
}
