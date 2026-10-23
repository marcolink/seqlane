import { Effect } from "effect";
import {
  type ConflictSet,
  type IntegrationResult,
  type ResolutionAttemptReport,
  type ResolveMergeConflictsPorts,
  type ResolveMergeConflictsRequest,
} from "./contracts.js";
import { ActionResolutionError } from "./errors.js";
import { validateStagedWhitespaceAndMarkers } from "./marker-validation.js";
import { resolveConflictAttemptEffect } from "./conflict-resolution-attempt.js";
import type { ResolutionProgress } from "./progress.js";

export interface ResolutionRunState {
  attempts: number;
  reports: ResolutionAttemptReport[];
}

const io = <A>(run: () => Promise<A>) =>
  Effect.uninterruptible(
    Effect.tryPromise({ try: run, catch: (cause) => cause }),
  );

function continueRebase(
  ports: ResolveMergeConflictsPorts,
  conflicts: ConflictSet,
): Effect.Effect<ConflictSet | "completed", unknown> {
  return Effect.gen(function* () {
    const continuation = yield* io(() => ports.git.continueRebase());
    const remaining = yield* io(() => ports.git.readConflictSet());
    if (remaining.length > 0) return remaining;
    const state = yield* io(() => ports.git.inspectState());
    if (continuation.exitCode === 0 && !state.rebaseInProgress)
      return "completed";
    if (state.rebaseInProgress && state.worktreeClean) {
      const skipped = yield* io(() => ports.git.skipRebase());
      if (skipped.exitCode === 0) {
        const afterSkip = yield* io(() => ports.git.readConflictSet());
        const afterSkipState = yield* io(() => ports.git.inspectState());
        if (afterSkip.length > 0 && afterSkipState.rebaseInProgress)
          return afterSkip;
        if (afterSkip.length === 0 && !afterSkipState.rebaseInProgress)
          return "completed";
      }
    }
    return yield* Effect.fail(
      new ActionResolutionError(
        "git",
        "GIT_OPERATION_FAILED",
        "The rebase could not continue after conflict resolution.",
        { continuation, conflicts },
      ),
    );
  });
}

export function resolveIntegrationEffect(options: {
  readonly request: ResolveMergeConflictsRequest;
  readonly ports: ResolveMergeConflictsPorts;
  readonly integration: Exclude<IntegrationResult, { kind: "error" }>;
  readonly progress: ResolutionProgress;
  readonly state: ResolutionRunState;
  readonly startAgent: () => Effect.Effect<void, unknown>;
}): Effect.Effect<boolean, unknown> {
  return Effect.gen(function* () {
    const { integration, ports, request, progress, state, startAgent } =
      options;
    const resolved =
      integration.kind === "clean" &&
      integration.operation === "rebase" &&
      integration.headAfter !== integration.headBefore;
    if (integration.kind !== "conflicted") return resolved;

    yield* io(
      () => ports.files.captureIntegrationBaseline?.() ?? Promise.resolve(),
    );
    let conflicts = yield* io(() => ports.git.readConflictSet());
    if (conflicts.length === 0) {
      return yield* Effect.fail(
        new ActionResolutionError(
          "git",
          "CONFLICT_SET_REQUIRED",
          "Git reported a conflict without an unmerged index.",
        ),
      );
    }
    progress.conflictStop(request.strategy);
    while (true) {
      if (state.attempts >= request.maxAttempts) {
        return yield* Effect.fail(
          new ActionResolutionError(
            "attempt-limit",
            "ATTEMPT_LIMIT_EXCEEDED",
            "The maximum number of resolution attempts was exceeded.",
          ),
        );
      }
      state.attempts += 1;
      const attempt = yield* resolveConflictAttemptEffect({
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
      yield* io(() => validateStagedWhitespaceAndMarkers(ports.git, conflicts));
      if (request.strategy === "merge") return true;
      const next = yield* continueRebase(ports, conflicts);
      if (next === "completed") return true;
      yield* io(
        () => ports.files.captureIntegrationBaseline?.() ?? Promise.resolve(),
      );
      conflicts = next;
      progress.conflictStop(request.strategy);
    }
  });
}
