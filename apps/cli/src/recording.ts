import {
  closeSync,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import type { ExecutionEventConsumer } from "./event-dispatcher.js";
import {
  createRecordingEventValidator,
  decodeSeqlaneRecording,
  createRecordingHeader,
  encodeRecordingEvent,
  encodeRecordingHeader,
  MAX_RECORDING_BYTES,
  MAX_RECORDING_EVENTS,
  type SeqlaneRecording,
} from "./recording-format.js";

export {
  MAX_RECORDING_BYTES,
  MAX_RECORDING_EVENTS,
  type SeqlaneRecording,
  type SeqlaneRecordingHeader,
} from "./recording-format.js";

export interface RecordingOptions {
  readonly maxBytes?: number;
  readonly maxEvents?: number;
}

function writeAll(fd: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    offset += writeSync(fd, bytes, offset, bytes.length - offset);
  }
}

function assertPositiveBound(
  value: number | undefined,
  fallback: number,
): number {
  const bound = value ?? fallback;
  if (!Number.isSafeInteger(bound) || bound < 1) {
    throw new Error("Recording bounds must be positive safe integers");
  }
  return bound;
}

export function createRecordingConsumer(
  path: string,
  workflowId: string,
  options: RecordingOptions = {},
): ExecutionEventConsumer {
  const header = createRecordingHeader(workflowId);
  const maxBytes = assertPositiveBound(options.maxBytes, MAX_RECORDING_BYTES);
  const maxEvents = assertPositiveBound(
    options.maxEvents,
    MAX_RECORDING_EVENTS,
  );
  const headerLine = encodeRecordingHeader(header);
  const headerBytes = Buffer.byteLength(headerLine, "utf8");
  if (headerBytes > maxBytes) throw new Error("Recording byte limit exceeded");

  const fd = openSync(path, "wx");
  try {
    writeAll(fd, headerLine);
  } catch (error) {
    closeSync(fd);
    throw error;
  }

  let bytesWritten = headerBytes;
  let eventCount = 0;
  const eventValidator = createRecordingEventValidator();
  let closed = false;

  const closeFile = (): void => {
    if (closed) return;
    closed = true;
    closeSync(fd);
  };

  return {
    consume(event) {
      if (closed) throw new Error("Recording consumer is closed");
      if (eventCount >= maxEvents) {
        throw new Error("Recording event limit exceeded");
      }
      const encoded = encodeRecordingEvent(event);
      const eventBytes = Buffer.byteLength(encoded, "utf8");
      if (bytesWritten + eventBytes > maxBytes) {
        throw new Error("Recording byte limit exceeded");
      }
      const commitEvent = eventValidator.validate(event);
      writeAll(fd, encoded);
      bytesWritten += eventBytes;
      eventCount += 1;
      commitEvent();
    },
    async flush() {
      if (!closed) fsyncSync(fd);
    },
    async close() {
      if (closed) return;
      try {
        fsyncSync(fd);
      } finally {
        closeFile();
      }
    },
  };
}

function readBoundedFile(path: string): string {
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("Recording must be a regular file");
    const size = stat.size;
    if (size > MAX_RECORDING_BYTES) {
      throw new Error("Recording byte limit exceeded");
    }
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const read = readSync(fd, bytes, offset, size - offset, offset);
      if (read === 0) throw new Error("Recording file changed while reading");
      offset += read;
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new Error("Recording must be valid UTF-8", { cause: error });
    }
  } finally {
    closeSync(fd);
  }
}

export function readSeqlaneRecording(path: string): SeqlaneRecording {
  return decodeSeqlaneRecording(readBoundedFile(path));
}
