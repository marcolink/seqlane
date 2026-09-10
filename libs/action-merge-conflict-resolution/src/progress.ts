import type {
  ProgressPort,
  RebaseConflictCommit,
  ResolutionProgressEvent,
  ResolutionStrategy,
} from "./contracts.js";
import type { SecretRedactor } from "./recording.js";
import { compactBoundedText } from "./summary.js";

const MAX_SUBJECT_LENGTH = 160;

function formatProgressEvent(
  event: ResolutionProgressEvent,
  redactText: (value: string) => string,
): string {
  switch (event.kind) {
    case "started":
      return event.strategy === "rebase"
        ? `Rebase plan: ${event.commitsToReplay} commits to replay; max ${event.maxAttempts} resolution passes.`
        : `Merge resolution started; max ${event.maxAttempts} resolution passes.`;
    case "conflict-stop":
      return event.strategy === "rebase"
        ? `Conflict stop ${event.conflictStops}.`
        : `Merge conflict set ${event.conflictStops}.`;
    case "attempt-started": {
      const commit = event.commit;
      const suffix =
        commit === undefined
          ? ""
          : `; rebase commit ${commit.sha.slice(0, 7)} ${compactBoundedText(commit.subject, redactText, MAX_SUBJECT_LENGTH)}`;
      return `Resolution pass ${event.attempt}/${event.maxAttempts}${suffix}`;
    }
    case "push-started":
      return "Push started.";
    case "push-completed":
      return "Push completed.";
    case "completed":
      return `Complete: result=${event.result}; attempts=${event.attempts}; conflict-stops=${event.conflictStops}; pushed=${String(event.pushed)}.`;
    case "failed":
      return `Failed: ${event.category}/${event.code}; attempts=${event.attempts}; conflict-stops=${event.conflictStops}.`;
  }
}

export function createProgressWriter(
  write: (line: string) => void,
  redactor?: SecretRedactor,
): ProgressPort {
  const redactText = redactor?.redactText ?? ((value: string) => value);
  return {
    write: (event) => write(formatProgressEvent(event, redactText)),
  };
}

export interface ResolutionProgress {
  readonly conflictStops: number;
  readonly started: (
    event: Extract<ResolutionProgressEvent, { kind: "started" }>,
  ) => void;
  readonly conflictStop: (strategy: ResolutionStrategy) => void;
  readonly attemptStarted: (options: {
    readonly strategy: ResolutionStrategy;
    readonly attempt: number;
    readonly maxAttempts: number;
    readonly commit?: RebaseConflictCommit;
  }) => void;
  readonly pushStarted: () => void;
  readonly pushCompleted: () => void;
  readonly completed: (options: {
    readonly result: "no-change" | "updated";
    readonly attempts: number;
    readonly pushed: boolean;
  }) => void;
  readonly failed: (options: {
    readonly category: string;
    readonly code: string;
    readonly attempts: number;
  }) => void;
}

export function createResolutionProgress(
  progress?: ProgressPort,
): ResolutionProgress {
  let conflictStops = 0;
  const write = (event: ResolutionProgressEvent): void => {
    progress?.write(event);
  };
  return {
    get conflictStops() {
      return conflictStops;
    },
    started: (event) => write(event),
    conflictStop: (strategy) => {
      conflictStops += 1;
      write({ kind: "conflict-stop", strategy, conflictStops });
    },
    attemptStarted: ({ strategy, attempt, maxAttempts, commit }) =>
      write({
        kind: "attempt-started",
        strategy,
        attempt,
        maxAttempts,
        conflictStops,
        ...(commit === undefined ? {} : { commit }),
      }),
    pushStarted: () => write({ kind: "push-started" }),
    pushCompleted: () => write({ kind: "push-completed" }),
    completed: ({ result, attempts, pushed }) =>
      write({
        kind: "completed",
        result,
        attempts,
        conflictStops,
        pushed,
      }),
    failed: ({ category, code, attempts }) =>
      write({
        kind: "failed",
        category,
        code,
        attempts,
        conflictStops,
      }),
  };
}

export { formatProgressEvent };
