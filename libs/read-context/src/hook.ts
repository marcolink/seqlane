import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { classifyCommand } from "./command-classifier.js";
import { estimateFile } from "./size-estimator.js";
import { isPathWithinRoot } from "./security.js";
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

function rootDirectory(): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return undefined;
  }
}

function debug(message: string): void {
  if (process.env.READ_CONTEXT_DEBUG === "1")
    process.stderr.write(`[read-context] ${message}\n`);
}

export function runReadContextGuard(input: string): string {
  const parsed = jsonTextSchema.safeParse(input);
  if (!parsed.success) return "{}";
  const event = inputSchema(parsed.data);
  if (event?.command === undefined) return "{}";
  const candidate = classifyCommand(event.command);
  if (candidate.kind !== "full" && candidate.kind !== "bounded") {
    if (candidate.kind === "unsupported")
      debug("allowed unsupported or compound command");
    return "{}";
  }
  const root = rootDirectory();
  if (root === undefined) return "{}";
  const absolutePath = resolve(process.cwd(), candidate.path);
  if (!isPathWithinRoot(root, absolutePath)) return "{}";
  const estimate = estimateFile(absolutePath);
  if (estimate === undefined) return "{}";
  const maxLines = limit("READ_CONTEXT_MAX_LINES", 400);
  const maxBytes = limit("READ_CONTEXT_MAX_BYTES", 30_000);
  const maxTargetedLines = limit("READ_CONTEXT_MAX_TARGETED_LINES", 250);
  const requestedLines =
    candidate.kind === "bounded"
      ? candidate.endLine - candidate.startLine + 1
      : undefined;
  const blocked =
    candidate.kind === "bounded"
      ? (requestedLines ?? 0) > maxTargetedLines
      : estimate.lines > maxLines || estimate.bytes > maxBytes;
  if (!blocked) return "{}";
  const reason = `Broad read blocked: ${candidate.path} is approximately ${estimate.lines} lines / ${estimate.bytes} bytes. Use seqlane run read-context.ts for the workflow-read-context workflow with a focused question from the active task and this path as candidate evidence (for example, seqlane run read-context.ts --input '{"question":"...","paths":["${candidate.path}"]}' --runtime opencode --workspace "$PWD"). Afterwards use rg or a narrow sed/head/tail read for exact verification before editing.`;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}
