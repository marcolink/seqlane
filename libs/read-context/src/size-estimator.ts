import { readFileSync, statSync } from "node:fs";

export interface FileEstimate {
  readonly bytes: number;
  readonly lines: number;
}

export function estimateFile(path: string): FileEstimate | undefined {
  try {
    const bytes = statSync(path).size;
    const contents = readFileSync(path);
    return {
      bytes,
      lines:
        contents.length === 0
          ? 0
          : contents.toString("utf8").split("\n").length,
    };
  } catch {
    return undefined;
  }
}
