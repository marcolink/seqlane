import { Args, Flags } from "@oclif/core";
import type { JsonValue } from "@seqlane/core";
import type { RunRequest } from "@seqlane/protocol";
import {
  createExecutionEventBridge,
  NonSerializableRunOutputError,
  RuntimeError,
  startWorkflowRun,
} from "@seqlane/runtime";
import { createSeqlanePlanSnapshot } from "@seqlane/runtime/workflow";
import { createEventDispatcher } from "../event-dispatcher.js";
import {
  createCliRenderer,
  createOutputCapabilities,
  resolveRendererMode,
} from "../output.js";
import { outputModeOptions, parseOutputMode } from "../output-mode.js";
import {
  prepareStandaloneWorkspace,
  readStandaloneInput,
} from "../standalone-execution-preparation.js";
import { loadStandaloneWorkflow } from "../standalone-workflow.js";
import {
  assertStandaloneAdapter,
  startStandaloneAdapter,
} from "../standalone-adapter.js";
import { withExecutionOutputBoundary } from "../execution-output.js";
import { closeRunResources } from "../run-lifecycle.js";
import {
  createRunCancellationResult,
  createRunFailureResult,
  createRunSuccessResult,
} from "../run-result.js";
import {
  contextualizeCommandError,
  errorMessage,
  SeqlaneCommand,
  writeDiagnostic,
} from "../command.js";
import {
  runCommandResultSchema,
  type RunCommandResult,
} from "../cli-contracts.js";

function standaloneRequest(
  workflow: import("../standalone-workflow.js").LoadedStandaloneWorkflow,
  input: JsonValue,
  workspace: string,
  dryRun: boolean,
): RunRequest {
  return {
    type: "run.start",
    workflow: workflow.reference,
    input,
    // Retained only for the private result envelope until that protocol is retired.
    runtime: { id: "standalone", workspace },
    ...(dryRun ? { dryRun: true } : {}),
  };
}

function isResultSerializationFailure(error: unknown): boolean {
  return (
    error instanceof RuntimeError &&
    error.cause instanceof NonSerializableRunOutputError
  );
}

export default class RunCommand extends SeqlaneCommand {
  static override enableJsonFlag = true;
  static override description = "Run one explicit workflow entrypoint";

  static override examples = [
    '<%= config.bin %> run ./workflows/local-only-example/workflow.ts --input \'{"value":"local"}\'',
    "<%= config.bin %> run @acme/workflows/review#review --adapter opencode",
  ];

  static override args = {
    workflow: Args.string({
      description: "local file or installed package workflow entrypoint",
      required: true,
    }),
  };

  static override flags = {
    input: Flags.string({ char: "i", description: "JSON workflow input" }),
    "input-file": Flags.string({
      description:
        "Path to JSON input, or - to read JSON from stdin (maximum 1 MiB)",
    }),
    workspace: Flags.string({
      description: "Workspace path for file-accessing tasks",
    }),
    adapter: Flags.string({ description: "Native adapter identifier" }),
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
    try {
      assertStandaloneAdapter(flags.adapter);
    } catch (error) {
      this.error(errorMessage(error), { exit: 1 });
    }
    const jsonMode = this.jsonEnabled();
    if (jsonMode && flags.dry)
      this.error("--json cannot be combined with --dry", { exit: 1 });

    const capabilities = createOutputCapabilities();
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

    let loaded: Awaited<ReturnType<typeof loadStandaloneWorkflow>> | undefined;
    let dispatcher: ReturnType<typeof createEventDispatcher> | undefined;
    let renderer: ReturnType<typeof createCliRenderer>["renderer"] | undefined;
    const cancellation = new AbortController();
    let activeRun: ReturnType<typeof startWorkflowRun> | undefined;
    let cancellationSignal: "SIGINT" | "SIGTERM" | undefined;
    const cancel = (signal: "SIGINT" | "SIGTERM"): void => {
      if (cancellation.signal.aborted) {
        process.exitCode = 130;
        return;
      }
      cancellationSignal = signal;
      cancellation.abort();
      void activeRun?.cancel();
    };
    const onSigint = (): void => cancel("SIGINT");
    const onSigterm = (): void => cancel("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    try {
      const callerDirectory = process.cwd();
      const input = await readStandaloneInput({
        callerDirectory,
        input: flags.input,
        inputFile: flags["input-file"],
        signal: cancellation.signal,
        ...(flags["input-file"] === "-" ? { stdin: process.stdin } : {}),
      });
      const workspace = await prepareStandaloneWorkspace(
        callerDirectory,
        flags.workspace,
      );
      const workflow = await withExecutionOutputBoundary(
        jsonMode,
        () => loadStandaloneWorkflow(args.workflow, callerDirectory),
        (value) => writeDiagnostic(capabilities.stderr, value),
      );
      loaded = workflow;
      const request = standaloneRequest(workflow, input, workspace, flags.dry);

      if (flags.dry) {
        capabilities.stdout.write(
          JSON.stringify(createSeqlanePlanSnapshot(workflow.plan), null, 2) +
            "\n",
        );
        process.exitCode = 0;
        return;
      }

      renderer =
        terminalMode === undefined
          ? undefined
          : createCliRenderer(terminalMode, capabilities).renderer;
      dispatcher = createEventDispatcher(
        [
          {
            name: "output",
            consumer: {
              consume: (event) => renderer?.handle(event),
              flush: async () => undefined,
              close: async () => undefined,
            },
          },
        ],
        {
          onDiagnostic: (message) =>
            writeDiagnostic(capabilities.stderr, message),
        },
      );
      const events = createExecutionEventBridge(async (event) => {
        dispatcher?.consume(event);
      });
      const startedAt = new Date().toISOString();
      let run: ReturnType<typeof startWorkflowRun> | undefined;
      const outcome = await withExecutionOutputBoundary(
        jsonMode,
        async () => {
          run = activeRun = startWorkflowRun({
            workflow,
            input,
            standalone: {
              workspace,
              adapter: flags.adapter,
              startAdapter: startStandaloneAdapter,
            },
            events,
            signal: cancellation.signal,
            onDiagnostic: (message) =>
              writeDiagnostic(capabilities.stderr, message),
          });
          return run.outcome;
        },
        (value) => writeDiagnostic(capabilities.stderr, value),
      );
      if (run === undefined) throw new Error("Workflow run did not start");
      await events.flush();
      await dispatcher.flush();
      if (outcome.status === "succeeded") {
        let result: RunCommandResult;
        try {
          result = createRunSuccessResult(
            request,
            args.workflow,
            { workId: run.workId, runId: run.runId, startedAt },
            outcome.result,
          );
        } catch (error) {
          result = createRunFailureResult(
            error,
            "result-serialization",
            request,
            args.workflow,
            { workId: run.workId, runId: run.runId, startedAt },
          );
          process.exitCode = 1;
          if (!jsonMode)
            writeDiagnostic(capabilities.stderr, errorMessage(error));
          return jsonMode ? result : undefined;
        }
        process.exitCode = 0;
        return jsonMode ? result : undefined;
      }
      if (outcome.status === "cancelled") {
        const result = createRunCancellationResult(
          request,
          args.workflow,
          { workId: run.workId, runId: run.runId, startedAt },
          cancellationSignal === undefined ? "runtime_cancelled" : "signal",
          cancellationSignal === undefined
            ? "Run cancelled by the runtime"
            : `Run cancelled after ${cancellationSignal}`,
        );
        process.exitCode = 130;
        return jsonMode ? result : undefined;
      }
      const error =
        outcome.status === "failed"
          ? outcome.error
          : new Error("Run cancelled");
      const result = createRunFailureResult(
        error,
        isResultSerializationFailure(error)
          ? "result-serialization"
          : "execution",
        request,
        args.workflow,
        { workId: run.workId, runId: run.runId, startedAt },
      );
      process.exitCode = 1;
      if (!jsonMode) writeDiagnostic(capabilities.stderr, errorMessage(error));
      return jsonMode ? result : undefined;
    } catch (error) {
      if (cancellation.signal.aborted) {
        process.exitCode = 130;
        return;
      }
      this.error(contextualizeCommandError(errorMessage(error), error), {
        exit: 1,
      });
    } finally {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
      const cleanupErrors = await closeRunResources({
        dispatcher,
        finishRenderer: () => renderer?.finish(),
        closeHost: () => loaded?.dispose(),
      });
      for (const error of cleanupErrors) {
        writeDiagnostic(
          capabilities.stderr,
          `Cleanup failed: ${errorMessage(error)}`,
        );
      }
    }
  }
}
