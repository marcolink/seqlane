import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { resolveSafePath } from "./security.js";

export interface BoundedReadRequest {
  readonly startLine: number;
  readonly endLine: number;
  readonly maxBytes: number;
  readonly maxScanBytes: number;
}

export interface BoundedReadResult {
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly truncated: boolean;
  readonly excludedReason?: string;
}

/** Reads only the requested line range and byte budget from a real file. */
export function readBoundedFile(
  root: string,
  path: string,
  request: BoundedReadRequest,
): BoundedReadResult | undefined {
  const target = resolveSafePath(root, path, "file");
  if (target === undefined) return undefined;
  if (
    !Number.isSafeInteger(request.maxBytes) ||
    request.maxBytes <= 0 ||
    !Number.isSafeInteger(request.maxScanBytes) ||
    request.maxScanBytes <= 0
  )
    return undefined;
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
      const remainingScanBytes = request.maxScanBytes - offset;
      if (remainingScanBytes <= 0) {
        return {
          content: "",
          startLine: request.startLine,
          endLine: request.endLine,
          truncated: true,
          excludedReason: "scan-work budget",
        };
      }
      const count = readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, remainingScanBytes),
        offset,
      );
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
    if (!stopped && offset >= request.maxScanBytes && offset < size) {
      return {
        content: "",
        startLine: request.startLine,
        endLine: request.endLine,
        truncated: true,
        excludedReason: "scan-work budget",
      };
    }
    if (!stopped && line >= request.startLine && line <= request.endLine) {
      selectedLine = line;
    }
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
