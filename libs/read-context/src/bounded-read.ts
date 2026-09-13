import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { resolveSafePath } from "./security.js";

export interface BoundedReadRequest {
  readonly startLine: number;
  readonly endLine: number;
  readonly maxBytes: number;
}

export interface BoundedReadResult {
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly truncated: boolean;
}

/** Reads only the requested line range and byte budget from a real file. */
export function readBoundedFile(
  root: string,
  path: string,
  request: BoundedReadRequest,
): BoundedReadResult | undefined {
  const target = resolveSafePath(root, path, "file");
  if (target === undefined) return undefined;
  const descriptor = openSync(target, "r");
  try {
    const size = fstatSync(descriptor).size;
    const buffer = Buffer.allocUnsafe(8192);
    const bytes: number[] = [];
    let offset = 0;
    let line = 1;
    let selectedLine = request.startLine;
    let selected = false;
    let stopped = false;
    let stopPosition = 0;

    while (offset < size && !stopped) {
      const count = readSync(descriptor, buffer, 0, buffer.length, offset);
      if (count === 0) break;
      for (let index = 0; index < count; index += 1) {
        const value = buffer[index] ?? 0;
        if (line >= request.startLine && line <= request.endLine) {
          selected = true;
          if (bytes.length < request.maxBytes) bytes.push(value);
          if (bytes.length >= request.maxBytes) {
            stopPosition = offset + index + 1;
            stopped = true;
            break;
          }
          if (value === 10) {
            selectedLine = line;
            line += 1;
            if (line > request.endLine) {
              stopPosition = offset + index + 1;
              stopped = true;
              break;
            }
          }
        } else if (value === 10) {
          line += 1;
        }
      }
      offset += count;
    }

    if (!selected) return undefined;
    const endLine = Math.max(
      request.startLine,
      Math.min(request.endLine, selectedLine),
    );
    const position = stopped ? stopPosition : offset;
    return {
      content: Buffer.from(bytes).toString("utf8"),
      startLine: request.startLine,
      endLine,
      truncated:
        request.startLine > 1 ||
        (stopped && position < size) ||
        (!stopped && line <= request.endLine && position < size),
    };
  } finally {
    closeSync(descriptor);
  }
}
