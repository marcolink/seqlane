import {
  type ConflictSet,
  type IntegrationResult,
  type ResolutionAttemptReport,
  type ResolveMergeConflictsPorts,
  type ResolveMergeConflictsRequest,
} from "./contracts.js";
import { ActionResolutionError } from "./errors.js";
import { validateStagedWhitespaceAndMarkers } from "./marker-validation.js";
import { resolveConflictAttempt } from "./conflict-resolution-attempt.js";
import type { ResolutionProgress } from "./progress.js";

export interface ResolutionRunState {
  attempts: number;
  reports: ResolutionAttemptReport[];
}

async function continueRebase(
  ports: ResolveMergeConflictsPorts,
  conflicts: ConflictSet,
): Promise<ConflictSet | "completed"> {
  const continuation = await ports.git.continueRebase();
  const remaining = await ports.git.readConflictSet();
  if (remaining.length > 0) return remaining;
  const state = await ports.git.inspectState();
  if (continuation.exitCode === 0 && !state.rebaseInProgress)
    return "completed";
  if (state.rebaseInProgress && state.worktreeClean) {
    const skipped = await ports.git.skipRebase();
    if (skipped.exitCode === 0) {
      const afterSkip = await ports.git.readConflictSet();
      const afterSkipState = await ports.git.inspectState();
      if (afterSkip.length > 0 && afterSkipState.rebaseInProgress) {
        return afterSkip;
      }
      if (afterSkip.length === 0 && !afterSkipState.rebaseInProgress) {
        return "completed";
      }
    }
  }
  throw new ActionResolutionError(
    "git",
    "GIT_OPERATION_FAILED",
    "The rebase could not continue after conflict resolution.",
    { continuation, conflicts },
  );
}

export async function resolveIntegration(options: {
  readonly request: ResolveMergeConflictsRequest;
  readonly ports: ResolveMergeConflictsPorts;
  readonly integration: Exclude<IntegrationResult, { kind: "error" }>;
  readonly progress: ResolutionProgress;
  readonly state: ResolutionRunState;
  readonly startAgent: () => Promise<void>;
}): Promise<boolean> {
  const { integration, ports, request, progress, state, startAgent } = options;
  const resolved =
    integration.kind === "clean" &&
    integration.operation === "rebase" &&
    integration.headAfter !== integration.headBefore;
  if (integration.kind !== "conflicted") return resolved;

  await ports.files.captureIntegrationBaseline?.();
  let conflicts = await ports.git.readConflictSet();
  if (conflicts.length === 0) {
    throw new ActionResolutionError(
      "git",
      "CONFLICT_SET_REQUIRED",
      "Git reported a conflict without an unmerged index.",
    );
  }
  progress.conflictStop(request.strategy);
  while (true) {
    if (state.attempts >= request.maxAttempts) {
      throw new ActionResolutionError(
        "attempt-limit",
        "ATTEMPT_LIMIT_EXCEEDED",
        "The maximum number of resolution attempts was exceeded.",
      );
    }
    state.attempts += 1;
    const attempt = await resolveConflictAttempt({
      request,
      ports,
      conflicts,
      attempt: state.attempts,
      startAgent,
      onAttemptStarted: (commit) =>
        progress.attemptStarted({
          strategy: request.strategy,
          attempt: state.attempts,
          maxAttempts: request.maxAttempts,
          commit,
        }),
    });
    state.reports.push(attempt.report);
    if (attempt.remaining.length > 0) {
      conflicts = attempt.remaining;
      continue;
    }
    await validateStagedWhitespaceAndMarkers(ports.git, conflicts);
    if (request.strategy === "merge") return true;
    const next = await continueRebase(ports, conflicts);
    if (next === "completed") return true;
    await ports.files.captureIntegrationBaseline?.();
    conflicts = next;
    progress.conflictStop(request.strategy);
  }
}
