import {
  type ConflictSet,
  type GitRevision,
  type IntegrationResult,
  type ResolveMergeConflictsRequest,
  type ResolveMergeConflictsResult,
  type ResolveMergeConflictsPorts,
  type ResolutionAttemptReport,
} from "./contracts.js";
import { ActionResolutionError, resolutionErrorDetails } from "./errors.js";
import {
  classifyConflicts,
  validatePullRequestPreflight,
  validateRequest,
} from "./policy.js";
import { validateStagedWhitespaceAndMarkers } from "./marker-validation.js";
import type { ResolveMergeConflictsWorkflowOutput } from "@seqlane/runtime/workflows/resolve-merge-conflicts";

function operationalError(
  message: string,
  cause?: unknown,
): ActionResolutionError {
  return new ActionResolutionError(
    "operational",
    "OPERATION_FAILED",
    message,
    cause,
  );
}

function failureResult(
  attempts: number,
  error: unknown,
): ResolveMergeConflictsResult {
  const typed =
    error instanceof ActionResolutionError
      ? error
      : operationalError("Merge-conflict resolution failed.", error);
  return {
    kind: "error",
    result: "error",
    attempts,
    error: resolutionErrorDetails(typed),
  };
}

function integrationError(
  integration: Extract<IntegrationResult, { kind: "error" }>,
): never {
  throw new ActionResolutionError(
    integration.error.category,
    integration.error.code,
    "Git integration failed.",
    integration,
  );
}

function successResult(
  kind: "clean" | "resolved",
  request: ResolveMergeConflictsRequest,
  baseSha: GitRevision,
  headSha: GitRevision,
  attempts: number,
  pushed: boolean,
): ResolveMergeConflictsResult {
  if (kind === "clean") {
    return {
      kind,
      result: "no-change",
      strategy: request.strategy,
      baseSha,
      headSha,
      attempts,
      pushed,
    };
  }
  return {
    kind,
    result: "updated",
    strategy: request.strategy,
    baseSha,
    headSha,
    attempts,
    pushed,
  };
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

export async function resolveMergeConflicts(
  requestValue: unknown,
  ports: ResolveMergeConflictsPorts,
): Promise<ResolveMergeConflictsResult> {
  let attempts = 0;
  let result: ResolveMergeConflictsResult;
  const reports: ResolutionAttemptReport[] = [];
  let strategy: ResolveMergeConflictsRequest["strategy"] | undefined;
  let agentLifecycleStarted = false;
  let agentLifecycleStopped = false;
  const stopAgent = async (): Promise<void> => {
    if (!agentLifecycleStarted || agentLifecycleStopped) return;
    await ports.agent.stop?.();
    agentLifecycleStopped = true;
  };
  try {
    const request = validateRequest(requestValue);
    strategy = request.strategy;
    const metadata = await ports.github.readPullRequest(
      request.pullRequestNumber,
    );
    const currentRepository = metadata.baseRepository;
    const pullRequest = validatePullRequestPreflight(
      metadata,
      currentRepository,
    );
    const liveBase = await ports.github.readLiveBaseRevision(
      pullRequest.baseBranch,
    );
    const integration = await ports.git.integrate(
      request.strategy,
      liveBase.revision,
    );
    if (integration.headBefore !== pullRequest.headRevision) {
      throw new ActionResolutionError(
        "remote-race",
        "REMOTE_HEAD_CHANGED",
        "The pull-request head changed before integration completed.",
        integration,
      );
    }
    if (integration.kind === "error") integrationError(integration);

    const cleanHistoryChanged =
      integration.kind === "clean" &&
      integration.operation === "rebase" &&
      integration.headAfter !== integration.headBefore;
    let resolved = cleanHistoryChanged;

    if (integration.kind === "conflicted") {
      await ports.files.captureIntegrationBaseline?.();
      let conflicts = await ports.git.readConflictSet();
      if (conflicts.length === 0) {
        throw new ActionResolutionError(
          "git",
          "CONFLICT_SET_REQUIRED",
          "Git reported a conflict without an unmerged index.",
        );
      }
      while (true) {
        if (attempts >= request.maxAttempts) {
          throw new ActionResolutionError(
            "attempt-limit",
            "ATTEMPT_LIMIT_EXCEEDED",
            "The maximum number of resolution attempts was exceeded.",
          );
        }
        attempts += 1;
        const classified = classifyConflicts(conflicts);
        const rebaseCommit =
          request.strategy === "rebase"
            ? await ports.git.readRebaseConflictCommit?.()
            : undefined;
        let workflowOutput: ResolveMergeConflictsWorkflowOutput = {
          summary: "No model resolution was required.",
          resolvedFiles: conflicts.map(({ path }) => path),
          decisions: conflicts.map(({ path }) => ({
            file: path,
            decision: "Resolved mechanically without a model attempt.",
          })),
        };
        if (classified.agent.length > 0) {
          if (!agentLifecycleStarted) {
            agentLifecycleStarted = true;
            await ports.agent.start?.();
          }
          const agentRequest =
            await ports.files.prepareAgentWorkspace(conflicts);
          workflowOutput = await ports.agent.resolve(agentRequest);
          await ports.files.copyAgentEdits(agentRequest.paths);
        }
        const report: ResolutionAttemptReport = {
          attempt: attempts,
          ...(rebaseCommit === undefined
            ? {}
            : {
                commit: {
                  oldSha: rebaseCommit.sha,
                  subject: rebaseCommit.subject,
                },
              }),
          summary: workflowOutput.summary,
          decisions: workflowOutput.decisions,
        };
        reports.push(report);
        if (classified.lockfile.length > 0) {
          await ports.lockfile.regenerate();
        }
        await ports.files.validateTarget(conflicts);
        await ports.git.stageConflictSet(conflicts);
        const remaining = await ports.git.readConflictSet();
        if (remaining.length > 0) {
          conflicts = remaining;
          continue;
        }
        await validateStagedWhitespaceAndMarkers(ports.git, conflicts);
        if (request.strategy === "merge") {
          resolved = true;
          break;
        }
        const next = await continueRebase(ports, conflicts);
        if (next === "completed") {
          resolved = true;
          break;
        }
        conflicts = next;
      }
    }

    if (resolved && request.strategy === "merge" && request.commit) {
      await ports.commitAndPush.commit(pullRequest.baseBranch);
    }
    let pushed = false;
    if (resolved && request.push) {
      await stopAgent();
      await ports.commitAndPush.beforePush?.();
      await ports.commitAndPush.push({
        baseBranch: pullRequest.baseBranch,
        headBranch: pullRequest.headBranch,
        baseRevision: liveBase.revision,
        headRevision: pullRequest.headRevision,
      });
      pushed = true;
    }
    result = successResult(
      resolved ? "resolved" : "clean",
      request,
      liveBase.revision,
      pullRequest.headRevision,
      attempts,
      pushed,
    );
  } catch (error: unknown) {
    result = failureResult(attempts, error);
  } finally {
    if (agentLifecycleStarted && !agentLifecycleStopped) {
      try {
        await stopAgent();
      } catch (error: unknown) {
        result = failureResult(attempts, error);
      }
    }
  }
  await ports.summary.write(result, { strategy, attempts: reports });
  return result;
}
