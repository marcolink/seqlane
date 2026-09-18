import { Args, Flags } from "@oclif/core";
import { isJsonValue, type JsonValue } from "@seqlane/core";
import { type RunRequest, type SeqlaneExecutionEvent } from "@seqlane/protocol";
import { resolve } from "node:path";
import { closeSync, openSync, readSync } from "node:fs";
import { createEventDispatcher } from "../event-dispatcher.js";
import {
  createCliRenderer,
  createOutputCapabilities,
  resolveRendererMode,
} from "../output.js";
import { outputModeOptions, parseOutputMode } from "../output-mode.js";
import {
  isDirectWorkflowReference,
  parseWorkflowReference,
} from "../workflow-reference.js";
import {
  runCommandResultSchema,
  type RunCommandResult,
} from "../cli-contracts.js";
import { closeRunResources } from "../run-lifecycle.js";
import {
  agentRuntimeConfigurationEnvironment,
  createDirectRunAdapterConfiguration,
  directRunAdapterConfigurationEnvironment,
} from "../agent-runtime.js";
import {
  contextualizeCommandError,
  errorMessage,
  SeqlaneCommand,
  writeDiagnostic,
} from "../command.js";
import {
  createRunCancellationResult,
  createRunFailureResult,
  createRunSuccessResult,
  remoteError,
  type RunIdentity,
} from "../run-result.js";
import { writeSessionUiDiagnostic } from "../session-ui-diagnostic.js";
import { z } from "zod";

const localRuntimeId = "local";
const directRuntimeId = "direct";
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
  adapter: string | undefined,
  workspace: string | undefined,
  dryRun: boolean,
): RunRequest {
  if (!isDirectWorkflowReference(workflow)) {
    throw new Error(
      "run requires an explicit workflow file or <module-specifier>#<export-name>",
    );
  }
  return {
    type: "run.start",
    workflow: parseWorkflowReference(workflow),
    input: parseJsonInput(input),
    runtime: {
      id: adapter === undefined ? localRuntimeId : directRuntimeId,
      ...(workspace === undefined ? {} : { workspace }),
    },
    ...(dryRun ? { dryRun: true } : {}),
  };
}

export default class RunCommand extends SeqlaneCommand {
  static override enableJsonFlag = true;
  static override description = "Run one explicit workflow in a fresh runner";

  static override examples = [
    '<%= config.bin %> run ./workflows/local-only-example/workflow.ts --input \'{"value":"Seqlane"}\'',
    '<%= config.bin %> run ./workflows/minimal-example/workflow.ts --input \'{"topic":"Seqlane"}\' --adapter opencode',
  ];

  static override args = {
    workflow: Args.string({
      description: "explicit workflow file or <module-specifier>#<export-name>",
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
    adapter: Flags.string({
      description: "Concrete adapter for agent tasks",
      options: ["codex", "opencode"],
    }),
    "adapter-host": Flags.string({
      description: "Loopback host for an owned OpenCode service",
      relationships: [
        {
          type: "all",
          flags: [
            {
              name: "adapter",
              when: async (flags) => flags.adapter === "opencode",
            },
          ],
        },
      ],
    }),
    "adapter-port": Flags.integer({
      description: "Port for an owned OpenCode service (default: 0)",
      min: 0,
      max: 65_535,
      relationships: [
        {
          type: "all",
          flags: [
            {
              name: "adapter",
              when: async (flags) => flags.adapter === "opencode",
            },
          ],
        },
      ],
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
    dry: Flags.boolean({
      description: "Print the calculated Plan without executing workflow tasks",
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
    try {
      request = createRunRequest(
        args.workflow,
        readJsonInput(flags.input, flags["input-file"]),
        flags.adapter,
        flags.workspace,
        flags.dry,
      );
    } catch (error) {
      this.error(contextualizeCommandError(errorMessage(error), error), {
        exit: 1,
      });
    }

    const baseCapabilities = createOutputCapabilities();
    const capabilities = baseCapabilities;
    const terminalMode =
      jsonMode || flags.dry
        ? undefined
        : resolveRendererMode(parseOutputMode(flags.output), capabilities);
    if (
      terminalMode === "human" &&
      (!capabilities.isTTY || !capabilities.hasTerminalInput)
    ) {
      this.error("--output human requires terminal input and output", {
        exit: 1,
      });
    }
    let renderer: ReturnType<typeof createCliRenderer>["renderer"] | undefined;
    let dispatcher: ReturnType<typeof createEventDispatcher> | undefined;
    let runnerClient: import("../runner-client.js").RunnerClient | undefined;
    let identity: RunIdentity | undefined;

    try {
      try {
        renderer =
          terminalMode === undefined
            ? undefined
            : createCliRenderer(terminalMode, capabilities).renderer;
      } catch (error) {
        this.error(contextualizeCommandError(errorMessage(error), error), {
          exit: 1,
        });
      }

      const outputConsumer = {
        consume: (event: SeqlaneExecutionEvent) => {
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
        [{ name: "output", consumer: outputConsumer }],
        {
          onDiagnostic: (message) =>
            writeDiagnostic(capabilities.stderr, message),
        },
      );

      const { launchRunner } = await import("../runner-client.js");
      const {
        [agentRuntimeConfigurationEnvironment]: _legacy,
        [directRunAdapterConfigurationEnvironment]: _inheritedDirect,
        ...environment
      } = process.env;
      let adapterConfiguration: string | undefined;
      if (flags.adapter !== undefined) {
        try {
          adapterConfiguration = createDirectRunAdapterConfiguration({
            adapter: flags.adapter,
            ...(flags["adapter-host"] === undefined
              ? {}
              : { host: flags["adapter-host"] }),
            ...(flags["adapter-port"] === undefined
              ? {}
              : { port: flags["adapter-port"] }),
          });
        } catch (error) {
          this.error(contextualizeCommandError(errorMessage(error), error), {
            exit: 1,
          });
        }
      } else if (
        flags["adapter-host"] !== undefined ||
        flags["adapter-port"] !== undefined
      ) {
        this.error(
          "--adapter-host and --adapter-port require --adapter opencode",
          {
            exit: 1,
          },
        );
      }
      runnerClient = launchRunner(request, {
        environment: {
          ...environment,
          ...(adapterConfiguration === undefined
            ? {}
            : {
                [directRunAdapterConfigurationEnvironment]:
                  adapterConfiguration,
              }),
        },
        onExecutionEvent: (event) => {
          dispatcher?.consume(event);
          if (event.type === "run.started" && identity === undefined) {
            identity = {
              workId: event.workId,
              runId: event.runId,
              startedAt: event.metadata.occurredAt,
            };
          }
        },
        onRuntimeSessionUiAvailable: (notification) => {
          if (renderer?.mode === "human") return;
          if (renderer?.handleRuntimeSessionUi !== undefined) {
            renderer.handleRuntimeSessionUi(notification);
            return;
          }
          if (!jsonMode) {
            writeSessionUiDiagnostic(capabilities, notification.browserUrl);
          }
        },
      });
      const result = await runnerClient.result;
      process.exitCode = result.status;
      if ("failure" in result) {
        if (renderer?.handleRunnerFailure !== undefined) {
          renderer.handleRunnerFailure(result.failure);
        } else if (!jsonMode) {
          writeDiagnostic(
            capabilities.stderr,
            "seqlane runner error: " + result.failure.message,
          );
        }
        return jsonMode
          ? createRunFailureResult(result.failure, "execution", request)
          : undefined;
      }
      if (!jsonMode || identity === undefined) return;
      if (result.terminalEvent.type === "run.succeeded") {
        return createRunSuccessResult(
          request,
          sourceWorkflowReference,
          identity,
          result.terminalEvent.output,
        );
      }
      if (result.terminalEvent.type === "run.cancelled") {
        const signal =
          "cancellationSignal" in result
            ? result.cancellationSignal
            : undefined;
        return createRunCancellationResult(
          request,
          sourceWorkflowReference,
          identity,
          signal === undefined ? "runtime_cancelled" : "signal",
          signal === undefined
            ? "Run cancelled by the runtime"
            : `Run cancelled after ${signal}`,
        );
      }
      return createRunFailureResult(
        remoteError(result.terminalEvent.error),
        "execution",
        request,
        sourceWorkflowReference,
        identity,
      );
    } finally {
      const cleanupErrors = await closeRunResources({
        dispatcher,
        closeClient: () => runnerClient?.close(),
        finishRenderer: () => renderer?.finish(),
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
