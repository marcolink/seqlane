import { Args, Command, Constraints, Flags } from "@oclif/core";
import {
  isJsonValue,
  type JsonValue,
  type RunRequest,
  type WorkflowReference,
} from "@seqlane/core";
import type { SeqlaneExecutionEventConsumer } from "@seqlane/events";
import { dirname, extname, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchRunner } from "../runner-client.js";
import { createEventDispatcher } from "../event-dispatcher.js";
import { createStudioPublisher } from "../studio-publisher.js";
import { createRecordingConsumer } from "../recording.js";
import { defaultStudioPort, startStudioSession } from "@seqlane/studio";
import {
  connectTerminalResize,
  createCliRenderer,
  createOutputCapabilities,
} from "../output.js";
import { parseOutputMode } from "../output-mode.js";

const packageRequire = createRequire(import.meta.url);
const dryRunRuntimeId = "dry-run";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseWorkflowReference(value: string): WorkflowReference {
  const separator = value.lastIndexOf("#");
  if (separator === -1) {
    return {
      id: value,
      moduleSpecifier: resolveWorkflowFile(value),
      exportName: "default",
    };
  }

  if (separator === 0 || separator === value.length - 1) {
    throw new Error(
      "workflow must be a workflow file or <module-specifier>#<export-name>",
    );
  }

  const moduleSpecifier = value.slice(0, separator);
  const exportName = value.slice(separator + 1);
  let resolvedModuleSpecifier = moduleSpecifier;

  if (moduleSpecifier.startsWith(".") || moduleSpecifier.startsWith("/")) {
    resolvedModuleSpecifier = pathToFileURL(
      resolve(process.cwd(), moduleSpecifier),
    ).href;
  } else if (moduleSpecifier.startsWith("file:")) {
    resolvedModuleSpecifier = new URL(moduleSpecifier).href;
  }

  return {
    id: value,
    moduleSpecifier: resolvedModuleSpecifier,
    exportName,
  };
}

function resolveWorkflowFile(value: string): string {
  let path: string;
  try {
    path = value.startsWith("file:")
      ? fileURLToPath(value)
      : resolve(process.cwd(), value);
  } catch {
    throw new Error("workflow file reference must be a valid path or file URL");
  }

  if (!new Set([".ts", ".mts", ".js", ".mjs"]).has(extname(path))) {
    throw new Error(
      "workflow file must use a .ts, .mts, .js, or .mjs extension",
    );
  }

  return pathToFileURL(path).href;
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

function createRunRequest(
  workflow: string,
  input: string,
  runtime: string | undefined,
  workspace: string | undefined,
  dryRun: boolean,
): RunRequest {
  if (runtime === undefined && !dryRun) {
    throw new Error("--runtime is required unless --dry is set");
  }

  return {
    type: "run.start",
    workflow: parseWorkflowReference(workflow),
    input: parseJsonInput(input),
    runtime: {
      id: runtime ?? dryRunRuntimeId,
      ...(workspace === undefined ? {} : { workspace }),
    },
    ...(dryRun ? { dryRun: true } : {}),
  };
}

export default class RunCommand extends Command {
  static override description =
    "Run one explicitly selected workflow in a fresh runner";

  static override examples = [
    '<%= config.bin %> run ./examples/minimal-workflow.ts --input \'{"topic":"Seqlane"}\' --runtime local',
    '<%= config.bin %> run ./examples/minimal-workflow.ts --input \'{"topic":"Seqlane"}\' --runtime local --studio',
  ];

  static override args = {
    workflow: Args.string({
      description: "workflow file or <module-specifier>#<export-name>",
      required: true,
    }),
  };

  static override flags = {
    input: Flags.string({
      char: "i",
      description: "JSON workflow input",
      required: true,
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
    studio: Flags.boolean({
      description: "Use the local Studio",
    }),
    studioPort: Flags.integer({
      description: "Loopback port for the local Studio",
    }),
    record: Flags.string({
      description: "Write bounded canonical execution events to a new file",
    }),
    dry: Flags.boolean({
      description: "Print the calculated Plan without executing workflow tasks",
    }),
  };

  static override constraints: (typeof Command)["constraints"] = [
    Constraints.flag("runtime")
      .is.requiredAll()
      .unless.thisIsTrue((flags) => flags.dry === true),
  ];

  async run(): Promise<void> {
    const { args, flags } = await this.parse(RunCommand);
    let request: RunRequest;

    try {
      request = createRunRequest(
        args.workflow,
        flags.input,
        flags.runtime,
        flags.workspace,
        flags.dry,
      );
    } catch (error) {
      this.error(errorMessage(error));
    }

    let studioAddress: string | undefined;
    let ownedStudio: Awaited<ReturnType<typeof startStudioSession>> | undefined;
    if (flags.studio) {
      const port = flags.studioPort ?? defaultStudioPort;
      studioAddress = `http://127.0.0.1:${port}`;
      try {
        const health = await fetch(`${studioAddress}/health`);
        if (!health.ok)
          throw new Error(`Studio returned HTTP ${health.status}`);
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
    const renderer = flags.dry
      ? undefined
      : createCliRenderer(parseOutputMode(flags.output), capabilities).renderer;
    const disconnectResize =
      renderer === undefined
        ? () => undefined
        : connectTerminalResize(renderer, process.stdout);
    const studioPublisher =
      studioAddress === undefined
        ? undefined
        : createStudioPublisher(studioAddress, request.workflow.id, {
            onDiagnostic: (message) =>
              capabilities.stderr.write(message + "\n"),
          });
    let recordingConsumer: SeqlaneExecutionEventConsumer | undefined;
    if (flags.record !== undefined) {
      try {
        recordingConsumer = createRecordingConsumer(
          flags.record,
          request.workflow.id,
        );
      } catch (error) {
        await ownedStudio?.stop();
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
        ...(studioPublisher === undefined
          ? []
          : [{ name: "Studio", consumer: studioPublisher }]),
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
    await ownedStudio?.stop();
    process.exitCode = result.status;
  }
}
