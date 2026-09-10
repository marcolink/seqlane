import type { ReviewProgressEvent } from "@seqlane/action-code-review";

const MAX_FAILURE_MESSAGE_LENGTH = 600;
const MAX_FAILURE_LINE_LENGTH = 1_000;

interface FailureErrorLike {
  readonly category?: unknown;
  readonly code?: unknown;
  readonly message?: unknown;
}

export interface ReviewFailureContext {
  readonly lastTask?: {
    readonly label: string;
    readonly taskId?: string;
    readonly status?: string;
  };
  readonly elapsedMs?: number;
}

function safeText(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.length === 0) return fallback;
  return value;
}

function safeIdentifier(value: unknown, fallback: string): string {
  const text = safeText(value, fallback).replace(/[^A-Za-z0-9._:/-]/g, "_");
  return text.length > 120 ? text.slice(0, 120) : text;
}

function sanitizeMessage(value: unknown): string {
  const message = safeText(value, "Unknown Seqlane error")
    .split("")
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .replace(
      /((?:ghp_|gho_|github_pat_|sk-|Bearer\s+)[A-Za-z0-9._-]+)/gi,
      "[REDACTED]",
    )
    .replace(
      /((?:token|api[-_]?key|password|secret)\s*[=:]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    )
    .trim();
  if (message.length <= MAX_FAILURE_MESSAGE_LENGTH) return message;
  return `${message.slice(0, MAX_FAILURE_MESSAGE_LENGTH - 3)}...`;
}

function formatElapsed(elapsedMs: number | undefined): string | undefined {
  if (elapsedMs === undefined || !Number.isFinite(elapsedMs) || elapsedMs < 0)
    return undefined;
  return `${(elapsedMs / 1_000).toFixed(1)}s`;
}

export function createReviewFailureContext(): {
  readonly observe: (event: ReviewProgressEvent) => void;
  readonly snapshot: () => ReviewFailureContext;
} {
  let lastTask: ReviewFailureContext["lastTask"];
  let elapsedMs: number | undefined;

  return {
    observe: (event) => {
      if (event.kind === "task-started") {
        lastTask = {
          label: event.label,
          ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
        };
      } else if (event.kind === "task-completed") {
        lastTask = {
          label: event.label,
          ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
          status: event.status,
        };
      } else if (event.kind === "review-completed") {
        elapsedMs = event.elapsedMs;
      }
    },
    snapshot: () => ({
      ...(lastTask === undefined ? {} : { lastTask }),
      ...(elapsedMs === undefined ? {} : { elapsedMs }),
    }),
  };
}

/** Formats only bounded, Action-safe fields from a failed review result. */
export function formatCodeReviewFailure(
  error: unknown,
  context: ReviewFailureContext = {},
): string {
  const candidate: FailureErrorLike =
    error !== null && typeof error === "object"
      ? (error as FailureErrorLike)
      : {};
  const category = safeIdentifier(candidate.category, "UnknownError");
  const code = safeIdentifier(candidate.code, "UNSPECIFIED");
  const details = [
    `category=${category}`,
    `code=${code}`,
    `message="${sanitizeMessage(candidate.message)}"`,
  ];
  if (context.lastTask !== undefined) {
    const task = safeIdentifier(context.lastTask.label, "unknown-task");
    const taskId =
      context.lastTask.taskId === undefined
        ? undefined
        : safeIdentifier(context.lastTask.taskId, "unknown-task-id");
    details.push(
      `last-task=${task}${taskId === undefined ? "" : ` (${taskId})`}${context.lastTask.status === undefined ? "" : ` status=${safeIdentifier(context.lastTask.status, "unknown")}`}`,
    );
  }
  const elapsed = formatElapsed(context.elapsedMs);
  if (elapsed !== undefined) details.push(`elapsed=${elapsed}`);
  return `Seqlane review failed: ${details.join("; ")}`.slice(
    0,
    MAX_FAILURE_LINE_LENGTH,
  );
}
