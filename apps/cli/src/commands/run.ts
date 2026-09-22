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
import { parseDottedInputParameters } from "../input-parameters.js";
import { z } from "zod";

const localRuntimeId = "local";
const directRuntimeId = "direct";
const MAX_INPUT_BYTES = 1_048_576;
const openCodeAdapterOnlyRelationships = [
  {
    type: "none" as const,
    flags: [
      {
        name: "adapter",
        when: async (flags: Record<string, unknown>) =>
          flags.adapter !== "opencode",
      },
    ],
  },
];

function parseJsonInput(value: string, source: string): JsonValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${source} must contain valid JSON`);
  }

  if (!isJsonValue(parsed)) throw new Error(`${source} must be a JSON value`);
  return parsed;
}

const runInputSourceSchema = z.strictObject({
  input: z.string().optional(),
  inputFile: z.string().optional(),
  inputParameters: z.array(z.string()).optional(),
});

type RunInputSource = z.output<typeof runInputSourceSchema>;

function parseRunInputSource(
  inlineInput: string | undefined,
  inputFile: string | undefined,
  inputParameters: string[] | undefined,
): RunInputSource {
  const result = runInputSourceSchema.safeParse({
    input: inlineInput,
    inputFile,
    inputParameters,
  });
  if (!result.success) throw new Error("invalid workflow input source");
  const sourceCount = [
    result.data.input,
    result.data.inputFile,
    result.data.inputParameters,
  ].filter((source) => source !== undefined).length;
  if (sourceCount > 1) {
    throw new Error("use only one of --input, --input-file, or --input.<path>");
  }
  return result.data;
}

function readJsonInput(
  inlineInput: string | undefined,
  inputFile: string | undefined,
  inputParameters: string[] | undefined,
): string {
  const source = parseRunInputSource(inlineInput, inputFile, inputParameters);
  if (source.input !== undefined) {
    assertInputSize(source.input, "--input");
    return source.input;
  }
  if (source.inputParameters !== undefined) {
    const input = JSON.stringify(
      parseDottedInputParameters(source.inputParameters),
    );
    assertInputSize(input, "--input.<path>");
    return input;
  }
  if (source.inputFile === undefined) return "{}";

  let fileDescriptor: number | undefined;
  const isStdin = source.inputFile === "-";
  try {
    fileDescriptor = isStdin ? 0 : openSync(resolve(source.inputFile), "r");
    const buffer = Buffer.allocUnsafe(MAX_INPUT_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = readSync(
        fileDescriptor,
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        isStdin ? null : bytesRead,
      );
      if (result === 0) break;
      bytesRead += result;
    }
    if (bytesRead > MAX_INPUT_BYTES) {
      const sourceName = isStdin ? "input" : "file";
      throw new Error(
        `${sourceName} exceeds the ${MAX_INPUT_BYTES}-byte limit`,
      );
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(0, bytesRead),
    );
  } catch (error) {
    const label = isStdin ? "--input-file -" : "--input-file";
    throw new Error(`${label} could not be read: ${errorMessage(error)}`, {
      cause: error,
    });
  } finally {
    if (fileDescriptor !== undefined && !isStdin) closeSync(fileDescriptor);
  }
}

function assertInputSize(input: string, source: string): void {
  if (Buffer.byteLength(input, "utf8") > MAX_INPUT_BYTES) {
    throw new Error(`${source} exceeds the ${MAX_INPUT_BYTES}-byte limit`);
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
    input: parseJsonInput(input, "workflow input"),
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
    "<%= config.bin %> run ./workflows/local-only-example/workflow.ts --input.value Seqlane",
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
      description:
        "JSON workflow input (maximum 1 MiB); use --input.<path> to set fields",
      exclusive: ["input-file"],
    }),
    "input-file": Flags.string({
      description:
        "Path to a JSON workflow input file, or - for stdin (maximum 1 MiB)",
      exclusive: ["input"],
    }),
    "input-param": Flags.string({
      description: "Internal dotted input field",
      multiple: true,
      multipleNonGreedy: true,
      hidden: true,
    }),
    adapter: Flags.string({
      description: "Concrete adapter for agent tasks",
      options: ["codex", "opencode"],
    }),
    "opencode-mode": Flags.string({
      description: "OpenCode connection mode. Defaults to managed.",
      options: ["managed", "external"],
      defaultHelp: "managed",
      dependsOn: ["adapter"],
      relationships: openCodeAdapterOnlyRelationships,
    }),
    "opencode-host": Flags.string({
      description: "Loopback host for the OpenCode service",
      dependsOn: ["adapter"],
      relationships: openCodeAdapterOnlyRelationships,
    }),
    "opencode-port": Flags.integer({
      description: "Port for the OpenCode service",
      min: 0,
      max: 65_535,
      dependsOn: ["adapter"],
      relationships: openCodeAdapterOnlyRelationships,
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
        readJsonInput(flags.input, flags["input-file"], flags["input-param"]),
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
          adapterConfiguration = createDirectRunAdapterConfiguration(
            flags.adapter === "opencode"
              ? {
                  adapter: "opencode",
                  mode: flags["opencode-mode"] ?? "managed",
                  ...(flags["opencode-host"] === undefined
                    ? {}
                    : { host: flags["opencode-host"] }),
                  ...(flags["opencode-port"] === undefined
                    ? {}
                    : { port: flags["opencode-port"] }),
                }
              : { adapter: "codex" },
          );
        } catch (error) {
          this.error(contextualizeCommandError(errorMessage(error), error), {
            exit: 1,
          });
        }
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
