import { isJsonValue, type JsonValue } from "@seqlane/core";
import type { RunRequest } from "@seqlane/protocol";
import { resolve } from "node:path";
import { closeSync, openSync, readSync } from "node:fs";
import { z } from "zod";
import { errorMessage } from "./command.js";
import {
  isDirectWorkflowReference,
  parseWorkflowReference,
} from "./workflow-reference.js";
import { parseDottedInputParameters } from "./input-parameters.js";

const localRuntimeId = "local";
const directRuntimeId = "direct";
const MAX_INPUT_BYTES = 1_048_576;
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

function readSelectedJsonInput(source: RunInputSource): string {
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

  return readInputText(source.inputFile);
}

function readInputText(inputFile: string): string {
  let fileDescriptor: number | undefined;
  const isStdin = inputFile === "-";
  try {
    fileDescriptor = isStdin ? 0 : openSync(resolve(inputFile), "r");
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

export class RunInputCancelledError extends Error {
  constructor(
    readonly signal: "SIGINT" | "SIGTERM",
    cause: unknown,
  ) {
    super(`Input read cancelled after ${signal}`, { cause });
    this.name = "RunInputCancelledError";
  }
}

/** Keeps signals responsive while explicit stdin waits for its next chunk. */
export async function readRunInput(
  inlineInput: string | undefined,
  inputFile: string | undefined,
  inputParameters: string[] | undefined,
): Promise<string> {
  const source = parseRunInputSource(inlineInput, inputFile, inputParameters);
  if (source.inputFile !== "-") return readSelectedJsonInput(source);
  const { readStandaloneInput } =
    await import("./standalone-execution-preparation.js");
  const controller = new AbortController();
  let signal: "SIGINT" | "SIGTERM" | undefined;
  const cancel = (received: "SIGINT" | "SIGTERM") => {
    signal = received;
    controller.abort();
    process.stdin.destroy();
  };
  const interrupt = () => cancel("SIGINT");
  const terminate = () => cancel("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    return JSON.stringify(
      await readStandaloneInput({
        callerDirectory: process.cwd(),
        inputFile: "-",
        stdin: process.stdin,
        signal: controller.signal,
      }),
    );
  } catch (cause) {
    if (signal !== undefined) throw new RunInputCancelledError(signal, cause);
    throw cause;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}
