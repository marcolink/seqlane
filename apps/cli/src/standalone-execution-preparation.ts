import type { JsonValue } from "@seqlane/core";
import { isJsonValue } from "@seqlane/core";
import { open, stat } from "node:fs/promises";
import { resolve } from "node:path";

const MAX_INPUT_BYTES = 1_048_576;

export interface StandaloneInputOptions {
  readonly callerDirectory: string;
  readonly input?: string;
  readonly inputFile?: string;
  readonly stdin?: AsyncIterable<Uint8Array>;
}

class InputSizeError extends Error {}
class InvalidUtf8Error extends Error {}

function callerPath(callerDirectory: string): string {
  return resolve(callerDirectory);
}

function parseJsonInput(value: string, source: string): JsonValue {
  if (Buffer.byteLength(value, "utf8") > MAX_INPUT_BYTES) {
    throw new InputSizeError(
      `${source} exceeds the ${MAX_INPUT_BYTES}-byte limit`,
    );
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (isJsonValue(parsed)) return parsed;
  } catch {
    // Use the same command-facing error for all invalid JSON text.
  }
  throw new Error(`${source} must contain one valid JSON value`);
}

async function readFileInput(path: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.allocUnsafe(MAX_INPUT_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const read = await handle.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
    if (bytesRead > MAX_INPUT_BYTES) {
      throw new InputSizeError(
        `--input-file exceeds the ${MAX_INPUT_BYTES}-byte limit`,
      );
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, bytesRead),
      );
    } catch (error) {
      throw new InvalidUtf8Error("--input-file must be UTF-8", {
        cause: error,
      });
    }
  } catch (error) {
    if (error instanceof InputSizeError) throw error;
    if (error instanceof InvalidUtf8Error) throw error;
    throw new Error(`--input-file could not be read: ${String(error)}`, {
      cause: error,
    });
  } finally {
    await handle?.close();
  }
}

async function readStdinInput(
  stdin: AsyncIterable<Uint8Array>,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of stdin) {
    length += chunk.byteLength;
    if (length > MAX_INPUT_BYTES) {
      throw new InputSizeError(
        `--input-file exceeds the ${MAX_INPUT_BYTES}-byte limit`,
      );
    }
    chunks.push(chunk);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } catch (error) {
    throw new InvalidUtf8Error("--input-file must be UTF-8", { cause: error });
  }
}

/** Reads only an explicitly selected JSON source; omitted input is an empty object. */
export async function readStandaloneInput(
  options: StandaloneInputOptions,
): Promise<JsonValue> {
  if (options.input !== undefined && options.inputFile !== undefined) {
    throw new Error("--input and --input-file cannot be combined");
  }
  if (options.input !== undefined)
    return parseJsonInput(options.input, "--input");
  if (options.inputFile === undefined) return {};
  if (options.inputFile === "-") {
    if (options.stdin === undefined)
      throw new Error("--input-file - requires an explicit stdin stream");
    return parseJsonInput(await readStdinInput(options.stdin), "--input-file");
  }
  return parseJsonInput(
    await readFileInput(
      resolve(callerPath(options.callerDirectory), options.inputFile),
    ),
    "--input-file",
  );
}

/** Resolves an execution workspace independently from workflow module loading. */
export async function prepareStandaloneWorkspace(
  callerDirectory: string,
  workspace?: string,
): Promise<string> {
  const path = resolve(callerPath(callerDirectory), workspace ?? ".");
  let details: Awaited<ReturnType<typeof stat>>;
  try {
    details = await stat(path);
  } catch (error) {
    throw new Error(`workspace could not be read: ${String(error)}`, {
      cause: error,
    });
  }
  if (!details.isDirectory()) throw new Error("workspace must be a directory");
  return path;
}
