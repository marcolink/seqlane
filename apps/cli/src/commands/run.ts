import { Args, Flags } from "@oclif/core";
import type { RunRequest } from "@seqlane/protocol";
import { parseClassifierCliOptions } from "../classifier-environment.js";
import { createOutputCapabilities, resolveRendererMode } from "../output.js";
import { outputModeOptions, parseOutputMode } from "../output-mode.js";
import {
  runCommandResultSchema,
  type RunCommandResult,
} from "../cli-contracts.js";
import { createDirectRunAdapterConfiguration } from "../agent-runtime.js";
import {
  contextualizeCommandError,
  errorMessage,
  SeqlaneCommand,
  writeDiagnostic,
} from "../command.js";
import { createRunFailureResult } from "../run-result.js";
import {
  createRunRequest,
  readRunInput,
  RunInputCancelledError,
} from "../run-input.js";
import { executeRunnerCommand } from "../run-execution.js";
export { createRunRequest } from "../run-input.js";

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
    "classifier-url": Flags.string({
      description: "Full System One HTTP endpoint URL for classifier tasks",
    }),
    "classifier-model": Flags.string({
      description: "System One model ID for classifier tasks",
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
    let classifierOptions: ReturnType<typeof parseClassifierCliOptions>;
    try {
      classifierOptions = parseClassifierCliOptions(
        flags["classifier-url"],
        flags["classifier-model"],
      );
      request = createRunRequest(
        args.workflow,
        await readRunInput(
          flags.input,
          flags["input-file"],
          flags["input-param"],
        ),
        flags.adapter,
        flags.workspace,
        flags.dry,
      );
    } catch (error) {
      if (error instanceof RunInputCancelledError) {
        process.exitCode = 130;
        if (jsonMode) return createRunFailureResult(error, "command");
        writeDiagnostic(process.stderr, error.message);
        return;
      }
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
    let adapterConfiguration: string | undefined;
    try {
      if (flags.adapter !== undefined) {
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
      }
    } catch (error) {
      this.error(contextualizeCommandError(errorMessage(error), error), {
        exit: 1,
      });
    }
    const result = await executeRunnerCommand({
      request,
      sourceReference: sourceWorkflowReference,
      classifierOptions,
      ...(adapterConfiguration === undefined ? {} : { adapterConfiguration }),
      jsonMode,
      dry: flags.dry,
      terminalMode,
      capabilities,
    });
    process.exitCode = result.exitStatus;
    return result.commandResult;
  }
}
