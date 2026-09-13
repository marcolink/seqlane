import { basename } from "node:path";

export type ClassifiedRead =
  | { readonly kind: "full"; readonly path: string }
  | {
      readonly kind: "bounded";
      readonly path: string;
      readonly startLine: number;
      readonly endLine: number;
    }
  | {
      readonly kind: "workflow";
      readonly runnerPath: string;
      readonly workflowPath: string;
      readonly args: readonly string[];
    }
  | {
      readonly kind: "path-bearing";
      readonly operation: "search" | "metadata";
      readonly paths: readonly string[];
    }
  | { readonly kind: "allow" | "unsupported" };

function tokenize(command: string): string[] | undefined {
  if (/[;&|<>`$()]/.test(command)) return undefined;
  const tokens: string[] = [];
  const pattern = /'([^']*)'|"([^"\\]*(?:\\.[^"\\]*)*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  let end = 0;
  while ((match = pattern.exec(command)) !== null) {
    if (command.slice(end, match.index).trim() !== "") return undefined;
    tokens.push(
      match[1] ?? match[2]?.replaceAll(/\\([\\"])/g, "$1") ?? match[3] ?? "",
    );
    end = pattern.lastIndex;
  }
  return command.slice(end).trim() === "" ? tokens : undefined;
}

function bounded(
  path: string,
  startLine: number,
  endLine: number,
): ClassifiedRead {
  return { kind: "bounded", path, startLine, endLine };
}

function pathBearing(
  operation: "search" | "metadata",
  tokens: readonly string[],
): ClassifiedRead {
  return {
    kind: "path-bearing",
    operation,
    paths: tokens.filter((token) => token !== "--" && !token.startsWith("-")),
  };
}

export function classifyCommand(command: string): ClassifiedRead {
  const tokens = tokenize(command.trim());
  if (tokens === undefined || tokens.length === 0)
    return { kind: "unsupported" };
  const executable = basename(tokens[0] ?? "");
  if (executable === "rg" || executable === "grep") {
    return pathBearing("search", tokens.slice(1));
  }
  if (executable === "git" && tokens[1] === "grep") {
    return pathBearing("search", tokens.slice(2));
  }
  if (
    tokens[0] === "pnpm" &&
    tokens[1] === "exec" &&
    tokens[2] === "node" &&
    tokens[3] === "apps/cli/bin/run.js" &&
    tokens[4] === "run" &&
    tokens[5] === "read-context.ts"
  ) {
    return {
      kind: "workflow",
      runnerPath: tokens[3],
      workflowPath: tokens[5],
      args: tokens.slice(6),
    };
  }
  if (
    executable === "git" &&
    (tokens[1] === "status" || tokens[1] === "diff" || tokens[1] === "log")
  ) {
    return pathBearing("metadata", tokens.slice(2));
  }
  if (
    (executable === "cat" || executable === "less" || executable === "more") &&
    tokens.length === 2
  ) {
    return { kind: "full", path: tokens[1] ?? "" };
  }
  if (
    (executable === "head" || executable === "tail") &&
    tokens.length === 4 &&
    tokens[1] === "-n"
  ) {
    const count = Number(tokens[2]);
    if (Number.isInteger(count) && count > 0)
      return bounded(tokens[3] ?? "", 1, count);
  }
  if (executable === "sed" && tokens.length === 4 && tokens[1] === "-n") {
    const match = /^(\d+),(\d+)p$/.exec(tokens[2] ?? "");
    if (match !== null) {
      const startLine = Number(match[1]);
      const endLine = Number(match[2]);
      if (startLine > 0 && endLine >= startLine)
        return bounded(tokens[3] ?? "", startLine, endLine);
    }
  }
  if (executable === "git" && tokens.length === 3 && tokens[1] === "show") {
    const separator = (tokens[2] ?? "").indexOf(":");
    if (separator > 0 && separator < (tokens[2] ?? "").length - 1) {
      return { kind: "full", path: (tokens[2] ?? "").slice(separator + 1) };
    }
  }
  return { kind: "unsupported" };
}
