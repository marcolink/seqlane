import { Effect } from "effect";
import {
  type ConflictPath,
  type ConflictSet,
  type ResolveMergeConflictsPorts,
  type ResolveMergeConflictsRequest,
  type ResolutionAttemptDiagnostics,
  type ResolutionAttemptReport,
  type RebaseConflictCommit,
} from "./contracts.js";
import { ActionResolutionError } from "./errors.js";
import { classifyConflicts } from "./policy.js";
import type { ResolveMergeConflictsWorkflowOutput } from "@seqlane/resolve-merge-conflicts-workflow";

const NO_ATTEMPT_DIAGNOSTICS: ResolutionAttemptDiagnostics = {
  eventCount: 0,
  truncated: false,
};

const io = <A>(run: (signal: AbortSignal) => Promise<A>) =>
  Effect.uninterruptible(
    Effect.tryPromise({ try: run, catch: (cause) => cause }),
  );

export function resolveConflictAttemptEffect(context: {
  readonly request: ResolveMergeConflictsRequest;
  readonly ports: ResolveMergeConflictsPorts;
  readonly conflicts: ConflictSet;
  readonly attempt: number;
  readonly startAgent: () => Effect.Effect<void, unknown>;
  readonly onAttemptStarted?: (
    commit: RebaseConflictCommit | undefined,
  ) => void | Promise<void>;
}): Effect.Effect<
  {
    readonly report: ResolutionAttemptReport;
    readonly remaining: ConflictSet;
  },
  unknown
> {
  return Effect.gen(function* () {
    const { request, ports, conflicts, attempt, startAgent } = context;
    const classified = classifyConflicts(conflicts, request.conflictHandlers);
    const rebaseCommit =
      request.strategy === "rebase"
        ? yield* io(
            (signal) =>
              ports.git.readRebaseConflictCommit?.() ??
              Promise.resolve(undefined),
          )
        : undefined;
    yield* io(() => Promise.resolve(context.onAttemptStarted?.(rebaseCommit)));
    const generatedPaths: ConflictPath[] = [];
    for (const group of classified.generated) {
      generatedPaths.push(
        ...(yield* io(() =>
          ports.generatedFiles.run(group.rule, group.conflicts),
        )),
      );
    }

    let workflowOutput: ResolveMergeConflictsWorkflowOutput = {
      summary: "No model resolution was required.",
      resolvedFiles: conflicts.map(({ path }) => path),
      decisions: conflicts.map(({ path }) => ({
        file: path,
        decision: "Resolved mechanically without a model attempt.",
      })),
    };
    if (classified.agent.length > 0) {
      yield* startAgent();
      const agentRequest = yield* io(() =>
        ports.files.prepareAgentWorkspace(classified.agent),
      );
      workflowOutput = yield* io(() => ports.agent.resolve(agentRequest));
      yield* io(() => ports.files.copyAgentEdits(agentRequest.paths));
    }
    if (classified.lockfile.length > 0) {
      if (ports.lockfile === undefined) {
        return yield* Effect.fail(
          new ActionResolutionError(
            "operational",
            "LOCKFILE_REGENERATION_FAILED",
            "The built-in lockfile handler is not available.",
          ),
        );
      }
      yield* io(() => ports.lockfile!.regenerate());
    }

    const report: ResolutionAttemptReport = {
      attempt,
      ...(rebaseCommit === undefined
        ? {}
        : {
            commit: { oldSha: rebaseCommit.sha, subject: rebaseCommit.subject },
          }),
      summary: workflowOutput.summary,
      decisions: workflowOutput.decisions,
      diagnostics:
        classified.agent.length > 0
          ? (ports.agent.getAttemptDiagnostics?.() ?? NO_ATTEMPT_DIAGNOSTICS)
          : NO_ATTEMPT_DIAGNOSTICS,
    };
    const uniqueGeneratedPaths = [...new Set(generatedPaths)];
    yield* io(() =>
      ports.files.validateTarget(conflicts, uniqueGeneratedPaths),
    );
    yield* io(() =>
      ports.git.stageConflictSet(conflicts, uniqueGeneratedPaths),
    );
    const remaining = yield* io(() => ports.git.readConflictSet());
    return { report, remaining };
  });
}
