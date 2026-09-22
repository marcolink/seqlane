import { closeSync, openSync, readSync, statSync } from "node:fs";
import { resolveSafePath } from "./security.ts";

export interface FileEstimate {
  readonly bytes: number;
  readonly lines: number;
}

export interface FileEstimateOptions {
  readonly root?: string;
  readonly maxBytes?: number;
  readonly maxLines?: number;
}

function countFileLines(
  target: string,
  bytes: number,
  maxLines: number | undefined,
): number {
  const descriptor = openSync(target, "r");
  try {
    const buffer = Buffer.allocUnsafe(8192);
    let lines = 1;
    let offset = 0;
    while (offset < bytes) {
      const count = readSync(descriptor, buffer, 0, buffer.length, offset);
      if (count === 0) break;
      offset += count;
      for (let index = 0; index < count; index += 1) {
        if (buffer[index] === 10) lines += 1;
        if (maxLines !== undefined && lines > maxLines) return maxLines + 1;
      }
    }
    return lines;
  } finally {
    closeSync(descriptor);
  }
}

export function estimateFile(
  path: string,
  options: FileEstimateOptions = {},
): FileEstimate | undefined {
  try {
    const target =
      options.root === undefined
        ? path
        : resolveSafePath(options.root, path, "file");
    if (target === undefined) return undefined;
    const bytes = statSync(target).size;
    const maxLines = options.maxLines;
    if (options.maxBytes !== undefined && bytes > options.maxBytes) {
      return { bytes, lines: maxLines === undefined ? 0 : maxLines + 1 };
    }
    return {
      bytes,
      lines: bytes === 0 ? 0 : countFileLines(target, bytes, maxLines),
    };
  } catch {
    return undefined;
  }
}
