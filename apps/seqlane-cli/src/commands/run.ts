import { Args, Command, Flags } from "@oclif/core";
import {
  isJsonValue,
  RuntimeError,
  type JsonValue,
  type RunRequest,
} from "@seqlane/core";
import type { SeqlaneExecutionEventConsumer } from "@seqlane/events";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { closeSync, openSync, readSync } from "node:fs";
import { createEventDispatcher } from "../event-dispatcher.js";
import { createExecutionEventBridge } from "@seqlane/runtime";
import {
  OperationalClient,
  OperationalClientError,
} from "../operational-client.js";
import { loadRuntimeAdapterConfiguration } from "@seqlane/runtime/operational-host";
import { startOwnedOperationalHost } from "../operational-command-host.js";
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

function remoteError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return new Error(error.message);
  }
  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error(String(error));
  }
}

async function cancelOperationalRun(
  client: OperationalClient,
  runId: string,
  workflowId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await client.cancelRun(runId, workflowId);
      return;
    } catch (error) {
      if (!(error instanceof OperationalClientError) || error.status !== 404) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new OperationalClientError(
    `Operational run "${runId}" did not become cancellable before the retry limit`,
  );
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

  async run(): Promise<void> {
    const { args, flags } = await this.parse(RunCommand);
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

    if (!flags.dry) {
      const workId = randomUUID();
      const runId = randomUUID();
      const events = createExecutionEventBridge(async (event) => {
        dispatcher.consume(event);
      });
      let client: OperationalClient | undefined;
      let ownedHost:
        Awaited<ReturnType<typeof startOwnedOperationalHost>> | undefined;
      let cancellationRequested = false;
      let cancellationPromise: Promise<void> | undefined;
      let cancellationError: unknown;
      const observationController = new AbortController();
      const requestCancellation = (): void => {
        cancellationRequested = true;
        if (client === undefined || cancellationPromise !== undefined) return;
        cancellationPromise = cancelOperationalRun(
          client,
          runId,
          request.workflow.id,
        );
        void cancellationPromise.catch((error: unknown) => {
          cancellationError = error;
          observationController.abort(error);
        });
      };
      let exitStatus = 1;
      const onSignal = (): void => {
        requestCancellation();
      };
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      try {
        ownedHost =
          flags["server-url"] === undefined
            ? await startOwnedOperationalHost({
                roots: workflowRootsFromFlags(flags),
                workflow: request.workflow,
                workflowInput: request.input,
                host: flags.hostname,
                port: flags.port,
                storageUrl: flags["storage-url"],
                adapterConfiguration,
                eventSink: () => events,
                onSessionUiAvailable: (notification) => {
                  if (renderer?.handleRuntimeSessionUi !== undefined) {
                    renderer.handleRuntimeSessionUi(notification);
                    return;
                  }
                  capabilities.stderr.write(
                    `Seqlane session UI: ${notification.browserUrl}\n`,
                  );
                },
              })
            : undefined;
        client = new OperationalClient(
          flags["server-url"] ?? ownedHost?.address ?? "",
        );
        if (cancellationRequested) requestCancellation();
        events.emit({ type: "run.started", workId, runId });
        const result = await client.startRun({
          workflowId: request.workflow.id,
          runId,
          workId,
          input: request.input,
          runtimeId: request.runtime.id,
          workspace: request.runtime.workspace,
          signal: observationController.signal,
        });
        await cancellationPromise;
        if (cancellationError !== undefined) throw cancellationError;
        if (
          cancellationRequested ||
          result.status === "canceled" ||
          result.status === "cancelled"
        ) {
          events.emit({ type: "run.cancelled", workId, runId });
          exitStatus = 130;
        } else if (result.status === "success" && isJsonValue(result.result)) {
          events.emit({
            type: "run.succeeded",
            workId,
            runId,
            output: result.result,
          });
          exitStatus = 0;
        } else {
          events.emit({
            type: "run.failed",
            workId,
            runId,
            error: new RuntimeError(
              result.error === undefined
                ? new Error(
                    `Operational run ended with status "${result.status}"`,
                  )
                : remoteError(result.error),
            ),
          });
        }
      } catch (error) {
        let failure = error;
        if (cancellationPromise !== undefined) {
          try {
            await cancellationPromise;
          } catch (cancellationFailure) {
            failure = cancellationFailure;
          }
        }
        if (cancellationError !== undefined) failure = cancellationError;
        events.emit({
          type: "run.failed",
          workId,
          runId,
          error: new RuntimeError(remoteError(failure)),
        });
      } finally {
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
        await ownedHost?.close().catch(() => undefined);
      }
      await events.flush();
      await dispatcher.flush();
      await dispatcher.close();
      try {
        await renderer?.finish();
      } catch (error) {
        capabilities.stderr.write(
          "seqlane output error: " + errorMessage(error) + "\n",
        );
      } finally {
        disconnectResize();
      }
      process.exitCode = exitStatus;
      return;
    }

    const { launchRunner } = await import("../runner-client.js");
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
