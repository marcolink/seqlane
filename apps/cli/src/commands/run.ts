import { Args, Flags } from "@oclif/core";
import { isJsonValue, type JsonValue } from "@seqlane/core";
import type { RunRequest } from "@seqlane/protocol";
import type { ExecutionEventConsumer } from "../event-dispatcher.js";
import { resolve } from "node:path";
import { closeSync, openSync, readSync } from "node:fs";
import { createEventDispatcher } from "../event-dispatcher.js";
import { loadRuntimeAdapterConfiguration } from "@seqlane/runtime/operational-host";
import { createRecordingConsumer } from "../recording.js";
import {
  connectTerminalResize,
  createCliRenderer,
  createOutputCapabilities,
} from "../output.js";
import { outputModeOptions, parseOutputMode } from "../output-mode.js";
import { workflowRootsFromFlags } from "../workflow-roots.js";
import {
  discoverWorkflowDescriptors,
  resolveWorkflowSelection,
  type WorkflowRoots,
} from "../workflow-discovery.js";
import { isExplicitWorkflowReference } from "../workflow-reference.js";
import {
  runCommandResultSchema,
  type RunCommandResult,
} from "../cli-contracts.js";
import { executeOperationalHostRun } from "../run-operational-host.js";
import { closeRunResources } from "../run-lifecycle.js";
import {
  contextualizeCommandError,
  errorMessage,
  SeqlaneCommand,
  writeDiagnostic,
} from "../command.js";
import { createRunFailureResult } from "../run-result.js";
import { z } from "zod";

const localRuntimeId = "local";
const MAX_INPUT_FILE_BYTES = 1_048_576;

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

const runInputSourceSchema = z.union([
  z.strictObject({
    input: z.string(),
    inputFile: z.undefined().optional(),
  }),
  z.strictObject({
    input: z.undefined().optional(),
    inputFile: z.string(),
  }),
]);

type RunInputSource = z.output<typeof runInputSourceSchema>;

function parseRunInputSource(
  inlineInput: string | undefined,
  inputFile: string | undefined,
): RunInputSource {
  const result = runInputSourceSchema.safeParse({
    input: inlineInput,
    inputFile,
  });
  if (!result.success) {
    throw new Error("specify exactly one of --input or --input-file");
  }
  return result.data;
}

function readJsonInput(
  inlineInput: string | undefined,
  inputFile: string | undefined,
): string {
  const source = parseRunInputSource(inlineInput, inputFile);
  if (source.input !== undefined) return source.input;

  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = openSync(resolve(source.inputFile), "r");
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

export default class RunCommand extends SeqlaneCommand {
  static override enableJsonFlag = true;
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
      options: outputModeOptions,
      default: "auto",
      exclusive: ["json"],
    }),
    record: Flags.string({
      description: "Write bounded canonical execution events to a new file",
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
      default: 0,
    }),
    "storage-url": Flags.string({
      description: "Mastra LibSQL storage URL for an owned host",
      default: "file:./.seqlane/mastra.db",
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

  protected override toErrorJson(error: unknown): RunCommandResult {
    return createRunFailureResult(error, "command");
  }

  protected override toSuccessJson(result: unknown): RunCommandResult {
    return runCommandResultSchema.parse(result);
  }

  async run(): Promise<RunCommandResult | void> {
    const { args, flags } = await this.parse(RunCommand);
    const sourceWorkflowReference = args.workflow;
    const jsonMode = this.jsonEnabled();
    if (jsonMode && flags.dry) {
      this.error("--json cannot be combined with --dry", { exit: 1 });
    }
    let request: RunRequest;
    let adapterConfiguration: unknown;

    try {
      request = createRunRequest(
        args.workflow,
        readJsonInput(flags.input, flags["input-file"]),
        flags.runtime,
        flags.workspace,
        flags.dry,
        workflowRootsFromFlags(flags),
      );
      if (
        flags["server-url"] === undefined &&
        request.runtime.id !== localRuntimeId &&
        request.runtime.id !== "test-fixture"
      ) {
        adapterConfiguration = loadRuntimeAdapterConfiguration();
      }
    } catch (error) {
      this.error(contextualizeCommandError(errorMessage(error), error), {
        exit: 1,
      });
    }

    let runnerClient: import("../runner-client.js").RunnerClient | undefined;
    const baseCapabilities = createOutputCapabilities();
    const capabilities = {
      ...baseCapabilities,
      onCancellationIntent: () => runnerClient?.cancel(),
    };
    if (
      !jsonMode &&
      !flags.dry &&
      flags.output === "human" &&
      (!capabilities.isTTY || process.stdin.isTTY !== true)
    ) {
      this.error(
        "--output human requires an interactive terminal for stdin and stdout",
        { exit: 1 },
      );
    }
    let recordingConsumer: ExecutionEventConsumer | undefined;
    let renderer: ReturnType<typeof createCliRenderer>["renderer"] | undefined;
    let disconnectResize: () => void = () => undefined;
    let dispatcher: ReturnType<typeof createEventDispatcher> | undefined;
    let operationalHostOwnsResources = false;

    try {
      if (flags.record !== undefined) {
        try {
          recordingConsumer = createRecordingConsumer(
            flags.record,
            request.workflow.id,
          );
        } catch (error) {
          this.error(
            contextualizeCommandError(
              `Could not create recording: ${errorMessage(error)}`,
              error,
            ),
            { exit: 1 },
          );
        }
        writeDiagnostic(
          capabilities.stderr,
          `Seqlane recording: bounded execution data is written to disk at ${flags.record}\n`,
        );
      }

      try {
        renderer =
          flags.dry || jsonMode
            ? undefined
            : createCliRenderer(parseOutputMode(flags.output), capabilities)
                .renderer;
      } catch (error) {
        this.error(contextualizeCommandError(errorMessage(error), error), {
          exit: 1,
        });
      }

      if (renderer !== undefined) {
        disconnectResize = connectTerminalResize(renderer, process.stdout);
      }
      const outputConsumer: ExecutionEventConsumer = {
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
            writeDiagnostic(
              capabilities.stderr,
              "seqlane output error: " + errorMessage(error),
            );
          }
        },
        flush: async () => undefined,
        close: async () => undefined,
      };
      dispatcher = createEventDispatcher(
        [
          { name: "output", consumer: outputConsumer },
          ...(recordingConsumer === undefined
            ? []
            : [{ name: "recording", consumer: recordingConsumer }]),
        ],
        {
          onDiagnostic: (message) =>
            writeDiagnostic(capabilities.stderr, message),
        },
      );

      if (flags.dry) {
        // Dry runs retain the legacy Plan-producing runner path. Native JSON
        // output is rejected above, so this branch must never return a run
        // result envelope through Oclif's JSON serializer.
        const { launchRunner } = await import("../runner-client.js");
        runnerClient = launchRunner(request, {
          onExecutionEvent: (event) => dispatcher?.consume(event),
          onRuntimeSessionUiAvailable: (notification) => {
            if (renderer?.handleRuntimeSessionUi !== undefined) {
              renderer.handleRuntimeSessionUi(notification);
              return;
            }
            writeDiagnostic(
              capabilities.stderr,
              `Seqlane session UI: ${notification.browserUrl}`,
            );
          },
        });
        const result = await runnerClient.result;
        if ("failure" in result) {
          if (renderer?.handleRunnerFailure !== undefined) {
            renderer.handleRunnerFailure(result.failure);
          } else {
            writeDiagnostic(
              capabilities.stderr,
              "seqlane runner error: " + result.failure.message,
            );
          }
        }
        process.exitCode = result.status;
        return;
      }

      // Transfer ownership before entering the operational host. From this
      // point, its finally block closes every acquired run resource exactly
      // once, including setup and cancellation failures.
      operationalHostOwnsResources = true;
      const run = await executeOperationalHostRun({
        request,
        sourceWorkflowReference,
        roots: workflowRootsFromFlags(flags),
        serverUrl: flags["server-url"],
        hostname: flags.hostname,
        port: flags.port,
        storageUrl: flags["storage-url"],
        adapterConfiguration,
        jsonMode,
        renderer,
        capabilities,
        dispatcher,
        disconnectResize,
      });
      for (const error of run.cleanupErrors) {
        writeDiagnostic(
          capabilities.stderr,
          "seqlane cleanup error: " + errorMessage(error),
        );
      }
      process.exitCode = run.exitStatus;
      return jsonMode ? run.commandResult : undefined;
    } finally {
      if (!operationalHostOwnsResources) {
        const cleanupErrors = await closeRunResources({
          dispatcher,
          recordingConsumer,
          closeClient: () => runnerClient?.close(),
          finishRenderer: () => renderer?.finish(),
          disconnectResize,
        });
        for (const error of cleanupErrors) {
          writeDiagnostic(
            capabilities.stderr,
            "seqlane cleanup error: " + errorMessage(error),
          );
        }
      }
    }
  }
}
