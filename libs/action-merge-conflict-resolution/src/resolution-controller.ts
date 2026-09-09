import {
  type GitRevision,
  type IntegrationResult,
  type ResolveMergeConflictsRequest,
  type ResolveMergeConflictsResult,
  type ResolveMergeConflictsPorts,
} from "./contracts.js";
import { ActionResolutionError, resolutionErrorDetails } from "./errors.js";
import { validatePullRequestPreflight, validateRequest } from "./policy.js";
import { createResolutionProgress } from "./progress.js";
import {
  resolveIntegration,
  type ResolutionRunState,
} from "./resolution-flow.js";

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

export async function resolveMergeConflicts(
  requestValue: unknown,
  ports: ResolveMergeConflictsPorts,
): Promise<ResolveMergeConflictsResult> {
  let result: ResolveMergeConflictsResult;
  const state: ResolutionRunState = { attempts: 0, reports: [] };
  let strategy: ResolveMergeConflictsRequest["strategy"] | undefined;
  let agentLifecycleStarted = false;
  let agentLifecycleStopped = false;
  const progress = createResolutionProgress(ports.progress);
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
    const commitsToReplay =
      request.strategy === "rebase"
        ? await ports.git.countRebaseCommits?.(liveBase.revision)
        : undefined;
    progress.started(request.strategy, request.maxAttempts, commitsToReplay);
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

    const resolved = await resolveIntegration({
      request,
      ports,
      integration,
      progress,
      state,
      startAgent: async () => {
        if (!agentLifecycleStarted) {
          agentLifecycleStarted = true;
          await ports.agent.start?.();
        }
      },
    });

    if (resolved && request.strategy === "merge" && request.commit) {
      await ports.commitAndPush.commit(pullRequest.baseBranch);
    }
    let pushed = false;
    if (resolved && request.push) {
      await stopAgent();
      progress.pushStarted();
      await ports.commitAndPush.beforePush?.();
      await ports.commitAndPush.push({
        baseBranch: pullRequest.baseBranch,
        headBranch: pullRequest.headBranch,
        baseRevision: liveBase.revision,
        headRevision: pullRequest.headRevision,
      });
      progress.pushCompleted();
      pushed = true;
    }
    result = successResult(
      resolved ? "resolved" : "clean",
      request,
      liveBase.revision,
      pullRequest.headRevision,
      state.attempts,
      pushed,
    );
  } catch (error: unknown) {
    result = failureResult(state.attempts, error);
  } finally {
    if (agentLifecycleStarted && !agentLifecycleStopped) {
      try {
        await stopAgent();
      } catch (error: unknown) {
        result = failureResult(state.attempts, error);
      }
    }
  }
  if (result.kind === "error") {
    progress.failed({
      category: result.error.category,
      code: result.error.code,
      attempts: state.attempts,
    });
  } else {
    progress.completed({
      result: result.result,
      attempts: state.attempts,
      pushed: result.pushed,
    });
  }
  await ports.summary.write(result, { strategy, attempts: state.reports });
  return result;
}
