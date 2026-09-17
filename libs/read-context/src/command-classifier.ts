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
  | { readonly kind: "unsafe"; readonly reason: string }
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

function unsafe(reason: string): ClassifiedRead {
  return { kind: "unsafe", reason };
}

const SEARCH_OPTIONS_WITH_ARGUMENT = new Set([
  "-e",
  "--regexp",
  "-f",
  "--file",
  "-g",
  "--glob",
  "-t",
  "--type",
  "-T",
  "--type-not",
  "--type-add",
  "--type-clear",
  "-m",
  "--max-count",
  "-A",
  "--after-context",
  "-B",
  "--before-context",
  "-C",
  "--context",
]);

const SEARCH_OPTIONS_DEFINE_PATTERN = new Set([
  "-e",
  "--regexp",
  "-f",
  "--file",
]);

const SEARCH_FLAGS = new Set([
  "-i",
  "--ignore-case",
  "-v",
  "--invert-match",
  "-w",
  "--word-regexp",
  "-x",
  "--line-regexp",
  "-n",
  "--line-number",
  "-l",
  "--files-with-matches",
  "-L",
  "--files-without-match",
  "-c",
  "--count",
  "-H",
  "--with-filename",
  "-h",
  "--no-filename",
  "-s",
  "--no-messages",
  "-r",
  "--recursive",
  "-R",
  "--dereference-recursive",
  "--json",
  "--pcre2",
  "--fixed-strings",
  "--case-sensitive",
  "--smart-case",
  "--no-smart-case",
  "--color",
  "--no-color",
  "--heading",
  "--no-heading",
  "--glob-case-insensitive",
]);

const METADATA_FLAGS = new Set([
  "--short",
  "--porcelain",
  "--branch",
  "--stat",
  "--name-only",
  "--name-status",
  "--cached",
  "--staged",
  "--no-color",
  "--color",
  "--oneline",
  "--decorate",
  "--follow",
  "--no-renames",
  "--find-renames",
  "--find-copies",
]);

const METADATA_OPTIONS_WITH_ARGUMENT = new Set([
  "-n",
  "--max-count",
  "-U",
  "--unified",
  "--untracked-files",
]);

function searchPathBearing(
  operation: "search" | "metadata",
  tokens: readonly string[],
): ClassifiedRead {
  let patternSeen = false;
  let endOfOptions = false;
  const paths: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "--") {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && token.startsWith("-")) {
      if (
        token === "--hidden" ||
        token === "--no-ignore" ||
        token === "--follow" ||
        token === "-uuu"
      )
        return unsafe(`unsupported broad ${operation} option: ${token}`);
      if (token.includes("=")) {
        const option = token.slice(0, token.indexOf("="));
        if (
          SEARCH_OPTIONS_WITH_ARGUMENT.has(option) ||
          SEARCH_FLAGS.has(option)
        ) {
          if (SEARCH_OPTIONS_DEFINE_PATTERN.has(option)) patternSeen = true;
          continue;
        }
        return unsafe(`unsupported ${operation} option: ${token}`);
      }
      if (SEARCH_OPTIONS_WITH_ARGUMENT.has(token)) {
        if (tokens[index + 1] === undefined)
          return unsafe(`missing argument for ${token}`);
        if (SEARCH_OPTIONS_DEFINE_PATTERN.has(token)) patternSeen = true;
        index += 1;
      } else if (!SEARCH_FLAGS.has(token)) {
        return unsafe(`unsupported ${operation} option: ${token}`);
      }
      continue;
    }
    if (!patternSeen) {
      patternSeen = true;
      continue;
    }
    paths.push(token);
  }
  if (!patternSeen || paths.length === 0)
    return unsafe(`unscoped ${operation} command`);
  return { kind: "path-bearing", operation, paths };
}

function metadataPathBearing(tokens: readonly string[]): ClassifiedRead {
  const separator = tokens.indexOf("--");
  if (separator < 0 || separator === tokens.length - 1)
    return unsafe("unscoped metadata command");
  for (let index = 0; index < separator; index += 1) {
    const token = tokens[index] ?? "";
    if (token.includes("=")) {
      const option = token.slice(0, token.indexOf("="));
      if (
        !METADATA_FLAGS.has(option) &&
        !METADATA_OPTIONS_WITH_ARGUMENT.has(option)
      )
        return unsafe(`unsupported metadata option: ${token}`);
      continue;
    }
    if (METADATA_OPTIONS_WITH_ARGUMENT.has(token)) {
      if (tokens[index + 1] === undefined || index + 1 >= separator)
        return unsafe(`missing argument for ${token}`);
      index += 1;
      continue;
    }
    if (!METADATA_FLAGS.has(token))
      return unsafe(`unsupported metadata option: ${token}`);
  }
  const paths = tokens.slice(separator + 1);
  if (paths.some((path) => path.length === 0 || path.startsWith("-")))
    return unsafe("unsupported metadata path");
  return { kind: "path-bearing", operation: "metadata", paths };
}

export function classifyCommand(command: string): ClassifiedRead {
  const tokens = tokenize(command.trim());
  if (tokens === undefined || tokens.length === 0)
    return { kind: "unsupported" };
  const executable = basename(tokens[0] ?? "");
  if (executable === "rg" || executable === "grep") {
    return searchPathBearing("search", tokens.slice(1));
  }
  if (executable === "git" && tokens[1] === "grep") {
    return searchPathBearing("search", tokens.slice(2));
  }
  if (
    tokens[0] === "pnpm" &&
    tokens[1] === "exec" &&
    tokens[2] === "node" &&
    tokens[3] === "apps/cli/bin/run.js" &&
    tokens[4] === "run" &&
    tokens[5] === "workflows/read-context/workflow.ts"
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
    return metadataPathBearing(tokens.slice(2));
  }
  if (
    (executable === "cat" || executable === "less" || executable === "more") &&
    (tokens.length === 2 || (tokens.length === 3 && tokens[1] === "--"))
  ) {
    return { kind: "full", path: tokens.at(-1) ?? "" };
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
    return unsafe("unsupported git show form");
  }
  if (
    executable === "cat" ||
    executable === "less" ||
    executable === "more" ||
    executable === "rg" ||
    executable === "grep" ||
    (executable === "git" &&
      ["grep", "status", "diff", "log", "show"].includes(tokens[1] ?? ""))
  )
    return unsafe("unsupported read command form");
  return { kind: "unsupported" };
}
