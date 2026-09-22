import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { classifyCommand, type ClassifiedRead } from "./command-classifier.ts";
import { estimateFile } from "./size-estimator.ts";
import {
  deniedPathReason,
  isPathWithinRoot,
  repositoryRelativePath,
  resolveSafePath,
} from "./security.ts";
import { readContextInputSchema } from "./schemas.ts";
import { z } from "zod";

const jsonTextSchema = z.string().transform((value, context) => {
  try {
    const parsed: unknown = JSON.parse(value);
    const validated = z.json().safeParse(parsed);
    if (validated.success) return validated.data;
  } catch {
    return z.NEVER;
  }
  context.addIssue({ code: "custom", message: "invalid JSON" });
  return z.NEVER;
});

const inputSchema = (value: unknown): { command?: string } | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const toolInput = Reflect.get(value, "tool_input");
  if (typeof toolInput !== "object" || toolInput === null) return undefined;
  const command = Reflect.get(toolInput, "command");
  return typeof command === "string" ? { command } : undefined;
};

function limit(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function rootDirectory(): string {
  return resolve(process.env.SEQLANE_READ_CONTEXT_ROOT ?? process.cwd());
}

function debug(message: string): void {
  if (process.env.READ_CONTEXT_DEBUG === "1")
    process.stderr.write(`[read-context] ${message}\n`);
}

function deny(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}

function validWorkflowArguments(
  root: string,
  args: readonly string[],
): boolean {
  let inputSeen = false;
  let workspaceSeen = false;
  let adapterSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--workspace") {
      if (workspaceSeen) return false;
      const workspace = args[index + 1];
      if (
        workspace === undefined ||
        resolveSafePath(root, workspace, "directory") === undefined
      ) {
        return false;
      }
      workspaceSeen = true;
      index += 1;
      continue;
    }
    if (argument === "--adapter") {
      if (adapterSeen) return false;
      if (args[index + 1] !== "codex") return false;
      adapterSeen = true;
      index += 1;
      continue;
    }
    if (argument !== "--input") return false;
    if (inputSeen) return false;
    const input = jsonTextSchema.safeParse(args[index + 1] ?? "");
    if (!input.success) return false;
    const request = readContextInputSchema.safeParse(input.data);
    if (!request.success) return false;
    for (const value of request.data.paths ?? []) {
      if (resolveSafePath(root, value, "file") === undefined) return false;
    }
    for (const value of request.data.scope ?? []) {
      if (resolveSafePath(root, value, "directory") === undefined) {
        return false;
      }
    }
    inputSeen = true;
    index += 1;
  }
  return inputSeen && workspaceSeen && adapterSeen;
}

function guardWorkflowCommand(
  root: string,
  candidate: Extract<ClassifiedRead, { kind: "workflow" }>,
): string {
  const runner = resolveSafePath(root, candidate.runnerPath, "file");
  const workflow = resolveSafePath(root, candidate.workflowPath, "file");
  return runner !== undefined &&
    workflow !== undefined &&
    validWorkflowArguments(root, candidate.args)
    ? "{}"
    : deny(
        "Read-context workflow command must use the repository-local runner, workflow, workspace, and evidence paths",
      );
}

function guardReadCommand(
  root: string,
  candidate: Extract<ClassifiedRead, { kind: "full" | "bounded" }>,
): string {
  const absolutePath = resolve(root, candidate.path);
  if (!isPathWithinRoot(root, absolutePath)) {
    return deny("Read-context guard rejected a path outside the repository");
  }
  const deniedReason = deniedPathReason(
    repositoryRelativePath(root, absolutePath),
  );
  if (deniedReason !== undefined) {
    return deny(`Read-context guard rejected a ${deniedReason}`);
  }
  if (resolveSafePath(root, absolutePath, "file") === undefined) {
    return deny(
      "Read-context guard rejected a missing, non-file, or symlinked repository path",
    );
  }
  const maxLines = limit("READ_CONTEXT_MAX_LINES", 400);
  const maxBytes = limit("READ_CONTEXT_MAX_BYTES", 30_000);
  const maxTargetedLines = limit("READ_CONTEXT_MAX_TARGETED_LINES", 250);
  const estimate = estimateFile(absolutePath, {
    root,
    maxBytes,
    maxLines,
  });
  if (estimate === undefined) return "{}";
  const requestedLines =
    candidate.kind === "bounded"
      ? candidate.endLine - candidate.startLine + 1
      : undefined;
  const blocked =
    candidate.kind === "bounded"
      ? (requestedLines ?? 0) > maxTargetedLines
      : estimate.lines > maxLines || estimate.bytes > maxBytes;
  if (!blocked) return "{}";
  const reason = `Broad read blocked: ${candidate.path} is approximately ${estimate.lines} lines / ${estimate.bytes} bytes. Use pnpm exec node apps/cli/bin/run.js run ./workflows/read-context/workflow.ts --input '{"question":"...","paths":["${candidate.path}"]}' --adapter codex --workspace "$PWD" for the read-context workflow with a focused question from the active task. Afterwards use rg or a narrow sed/head/tail read for exact verification before editing.`;
  return deny(reason);
}

function guardPathBearingCommand(
  root: string,
  candidate: Extract<ClassifiedRead, { kind: "path-bearing" }>,
): string {
  for (const path of candidate.paths) {
    const absolute = resolve(root, path);
    if (!isPathWithinRoot(root, absolute)) {
      return deny(
        `Read-context guard rejected a ${candidate.operation} path outside the repository`,
      );
    }
    const deniedReason = deniedPathReason(
      repositoryRelativePath(root, absolute),
    );
    if (deniedReason !== undefined) {
      return deny(
        `Read-context guard rejected a ${candidate.operation} of a ${deniedReason}`,
      );
    }
    if (resolveSafePath(root, absolute, "either") === undefined) {
      try {
        lstatSync(absolute);
        return deny(
          `Read-context guard rejected a ${candidate.operation} of a missing or symlinked repository path`,
        );
      } catch {
        // Allow search paths that do not exist yet; containment and denial
        // policy were still validated above.
      }
    }
  }
  return "{}";
}

export function runReadContextGuard(input: string): string {
  const parsed = jsonTextSchema.safeParse(input);
  if (!parsed.success) return "{}";
  const event = inputSchema(parsed.data);
  if (event?.command === undefined) return "{}";
  const candidate = classifyCommand(event.command);
  const root = rootDirectory();
  if (candidate.kind === "workflow")
    return guardWorkflowCommand(root, candidate);
  if (candidate.kind === "path-bearing")
    return guardPathBearingCommand(root, candidate);
  if (candidate.kind === "unsafe")
    return deny(`Read-context guard rejected ${candidate.reason}`);
  if (candidate.kind !== "full" && candidate.kind !== "bounded") {
    if (candidate.kind === "unsupported")
      debug("allowed unsupported or compound command");
    return "{}";
  }
  return guardReadCommand(root, candidate);
}
