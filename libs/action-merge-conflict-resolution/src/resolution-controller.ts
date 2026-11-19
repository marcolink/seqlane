import { Effect } from "effect";
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
  resolveIntegrationEffect,
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

const io = <A>(run: (signal: AbortSignal) => Promise<A>) =>
  Effect.uninterruptible(
    Effect.tryPromise({ try: run, catch: (cause) => cause }),
  );

export function resolveMergeConflictsEffect(
  requestValue: unknown,
  ports: ResolveMergeConflictsPorts,
): Effect.Effect<ResolveMergeConflictsResult, unknown> {
  const state: ResolutionRunState = { attempts: 0, reports: [] };
  let strategy: ResolveMergeConflictsRequest["strategy"] | undefined;
  let agentLifecycleStarted = false;
  let agentLifecycleStopped = false;
  const progress = createResolutionProgress(ports.progress);
  const stopAgent = () => {
    if (!agentLifecycleStarted || agentLifecycleStopped) return Effect.void;
    return io(() => ports.agent.stop?.() ?? Promise.resolve()).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          agentLifecycleStopped = true;
        }),
      ),
      Effect.asVoid,
    );
  };

  const work = Effect.gen(function* () {
    const request = yield* Effect.try({
      try: () => validateRequest(requestValue),
      catch: (cause) => cause,
    });
    strategy = request.strategy;
    const metadata = yield* io(() =>
      ports.github.readPullRequest(request.pullRequestNumber),
    );
    const pullRequest = validatePullRequestPreflight(
      metadata,
      metadata.baseRepository,
    );
    const liveBase = yield* io(() =>
      ports.github.readLiveBaseRevision(pullRequest.baseBranch),
    );
    if (request.strategy === "rebase") {
      const commitsToReplay = yield* io(() =>
        ports.git.countRebaseCommits(liveBase.revision),
      );
      progress.started({
        kind: "started",
        strategy: "rebase",
        maxAttempts: request.maxAttempts,
        commitsToReplay,
      });
    } else {
      progress.started({
        kind: "started",
        strategy: "merge",
        maxAttempts: request.maxAttempts,
      });
    }
    const integration = yield* io(() =>
      ports.git.integrate(request.strategy, liveBase.revision),
    );
    if (integration.headBefore !== pullRequest.headRevision) {
      return yield* Effect.fail(
        new ActionResolutionError(
          "remote-race",
          "REMOTE_HEAD_CHANGED",
          "The pull-request head changed before integration completed.",
          integration,
        ),
      );
    }
    if (integration.kind === "error") integrationError(integration);

    const resolved = yield* resolveIntegrationEffect({
      request,
      ports,
      integration,
      progress,
      state,
      startAgent: () =>
        io(() => {
          if (!agentLifecycleStarted) {
            agentLifecycleStarted = true;
            return ports.agent.start?.() ?? Promise.resolve();
          }
          return Promise.resolve();
        }).pipe(Effect.asVoid),
    });
    if (resolved && request.strategy === "merge" && request.commit) {
      yield* io(() => ports.commitAndPush.commit(pullRequest.baseBranch));
    }
    let pushed = false;
    if (resolved && request.push) {
      yield* stopAgent();
      progress.pushStarted();
      yield* io(() => ports.commitAndPush.beforePush?.() ?? Promise.resolve());
      yield* io(() =>
        ports.commitAndPush.push({
          baseBranch: pullRequest.baseBranch,
          headBranch: pullRequest.headBranch,
          baseRevision: liveBase.revision,
          headRevision: pullRequest.headRevision,
        }),
      );
      progress.pushCompleted();
      pushed = true;
    }
    return successResult(
      resolved ? "resolved" : "clean",
      request,
      liveBase.revision,
      pullRequest.headRevision,
      state.attempts,
      pushed,
    );
  });

  const scopedWork = Effect.scoped(
    Effect.acquireRelease(Effect.succeed(undefined), () =>
      stopAgent().pipe(Effect.catchCause(() => Effect.void)),
    ).pipe(
      Effect.andThen(
        Effect.gen(function* () {
          const result = yield* Effect.match(work, {
            onFailure: (cause) => failureResult(state.attempts, cause),
            onSuccess: (value) => value,
          });
          if (agentLifecycleStarted && !agentLifecycleStopped) {
            const stopped = yield* Effect.match(stopAgent(), {
              onFailure: (cause) => ({ error: cause }) as const,
              onSuccess: () => ({ ok: true }) as const,
            });
            if ("error" in stopped && result.kind !== "error") {
              return failureResult(state.attempts, stopped.error);
            }
          }
          return result;
        }),
      ),
    ),
  );

  return scopedWork.pipe(
    Effect.flatMap((result) =>
      Effect.gen(function* () {
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
        yield* Effect.uninterruptible(
          io(() =>
            ports.summary.write(result, { strategy, attempts: state.reports }),
          ).pipe(Effect.asVoid),
        );
        return result;
      }),
    ),
  );
}

export function resolveMergeConflicts(
  requestValue: unknown,
  ports: ResolveMergeConflictsPorts,
): Promise<ResolveMergeConflictsResult> {
  return Effect.runPromise(resolveMergeConflictsEffect(requestValue, ports));
}
