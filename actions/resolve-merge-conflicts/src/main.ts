import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import "./require-shim.js";

import * as core from "@actions/core";
import * as github from "@actions/github";
import { Effect } from "effect";
import {
  GitHubMetadataAdapter,
  NodeCommitAndPush,
  NodeGitCli,
  NodeLockfileRegenerator,
  NodeOpenCodeRuntime,
  NodeWorkspaceBoundary,
  NodeGeneratedFileHandler,
  createSeqlaneAgentRunner,
  createBoundedRecording,
  createSecretRedactor,
  createProgressWriter,
  createSummaryWriter,
  parseActionInputs,
  ActionResolutionError,
  resolutionErrorDetails,
  resolveMergeConflictsEffect,
  workflowDefinitionMetadata,
  type PullRequestMetadata,
  type WorkspaceFilesPort,
  validateSeparateWorkspaceRoots,
} from "@seqlane/action-merge-conflict-resolution";
import workflow from "@seqlane/resolve-merge-conflicts-workflow";
import { createLazyAgentPort } from "./lazy-agent-port.js";

function requiredWorkspace(): string {
  const value = process.env.GITHUB_WORKSPACE;
  if (value === undefined || value.length === 0) {
    throw new Error("GITHUB_WORKSPACE is required.");
  }
  return resolve(value);
}

export function resolverSkillDirectory(): string {
  return fileURLToPath(new URL("../skills", import.meta.url));
}

function workflowMetadata() {
  const ref = process.env.GITHUB_WORKFLOW_REF ?? github.context.ref;
  const sha = process.env.GITHUB_WORKFLOW_SHA ?? github.context.sha;
  if (ref.length === 0 || sha.length === 0) return undefined;
  return workflowDefinitionMetadata(ref, sha);
}

function runAction(
  signal: AbortSignal,
  agentRoot: string,
  markAgentWorkspaceUnsafe: () => void,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const secrets = [
      process.env.OPENAI_API_KEY,
      process.env.GITHUB_TOKEN,
      process.env.GH_TOKEN,
    ].filter(
      (value): value is string => value !== undefined && value.length > 0,
    );
    for (const secret of secrets) core.setSecret(secret);

    const actionRequest = parseActionInputs({
      pullRequestNumber: core.getInput("pull-request-number", {
        required: true,
      }),
      resolutionStrategy: core.getInput("resolution-strategy"),
      sourceDirectory: core.getInput("source-directory", { required: true }),
      targetDirectory: core.getInput("target-directory", { required: true }),
      commit: core.getInput("commit"),
      push: core.getInput("push"),
      maxAttempts: core.getInput("max-attempts"),
      conflictHandlers: core.getInput("conflict-handlers"),
    });
    const pushToken = core.getInput("push-token");
    if (actionRequest.push && pushToken.length === 0) {
      throw new ActionResolutionError(
        "input-validation",
        "PUSH_TOKEN_REQUIRED",
        "The push-token input is required when push is true.",
      );
    }
    if (pushToken.length > 0) {
      core.setSecret(pushToken);
      secrets.push(pushToken);
    }
    const root = requiredWorkspace();
    const { sourceRoot, targetRoot } = yield* Effect.uninterruptible(
      Effect.tryPromise({
        try: () =>
          validateSeparateWorkspaceRoots(
            resolve(root, actionRequest.sourceDirectory),
            resolve(root, actionRequest.targetDirectory),
          ),
        catch: (cause) => cause,
      }),
    );
    const request = actionRequest;
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";
    const octokit = github.getOctokit(token);
    const workflowRef = workflowMetadata();
    const redactor = createSecretRedactor(secrets);
    let metadata: PullRequestMetadata | undefined;
    let boundary: NodeWorkspaceBoundary | undefined;
    const git = new NodeGitCli(
      targetRoot,
      "git",
      signal,
      markAgentWorkspaceUnsafe,
    );
    const githubAdapter = new GitHubMetadataAdapter({
      signal,
      repository: {
        owner: github.context.repo.owner,
        name: github.context.repo.repo,
      },
      workflow: workflowRef,
      client: {
        getPullRequest: async (value) =>
          (
            await octokit.rest.pulls.get({
              owner: value.owner,
              repo: value.repository,
              pull_number: value.pullRequestNumber,
              ...(value.signal === undefined
                ? {}
                : { request: { signal: value.signal } }),
            })
          ).data,
        getBranchRef: async (value) =>
          (
            await octokit.rest.git.getRef({
              owner: value.owner,
              repo: value.repository,
              ref: value.ref,
              ...(value.signal === undefined
                ? {}
                : { request: { signal: value.signal } }),
            })
          ).data,
      },
    });
    const getBoundary = () => {
      if (metadata === undefined)
        throw new Error("Pull-request metadata is unavailable.");
      boundary ??= new NodeWorkspaceBoundary({
        sourceRoot,
        targetRoot,
        agentRoot,
        baseRevision: metadata.baseRevision,
        headRevision: metadata.headRevision,
        git,
      });
      return boundary;
    };
    const files: WorkspaceFilesPort = {
      captureIntegrationBaseline: async () =>
        getBoundary().captureIntegrationBaseline(),
      prepareAgentWorkspace: async (conflicts) => {
        return getBoundary().prepareAgentWorkspace(conflicts);
      },
      copyAgentEdits: async (paths) => getBoundary().copyAgentEdits(paths),
      validateTarget: async (conflicts, generatedPaths) =>
        getBoundary().validateTarget(conflicts, generatedPaths),
    };
    const runtime = new NodeOpenCodeRuntime({
      skillDirectory: resolverSkillDirectory(),
      onUncertain: markAgentWorkspaceUnsafe,
    });
    const ports = {
      github: {
        readPullRequest: async (number: number) => {
          metadata = await githubAdapter.readPullRequest(number);
          return metadata;
        },
        readLiveBaseRevision: (
          branch: Parameters<typeof githubAdapter.readLiveBaseRevision>[0],
        ) => githubAdapter.readLiveBaseRevision(branch),
      },
      git,
      files,
      lockfile: new NodeLockfileRegenerator({
        targetRoot,
        trustedSourceRoot: sourceRoot,
        signal,
        onUncertain: markAgentWorkspaceUnsafe,
      }),
      generatedFiles: new NodeGeneratedFileHandler({
        targetRoot,
        git,
        signal,
        onUncertain: markAgentWorkspaceUnsafe,
      }),
      agent: createLazyAgentPort(() => {
        if (metadata === undefined)
          throw new Error("Pull-request metadata is unavailable.");
        return createSeqlaneAgentRunner({
          workspace: agentRoot,
          workflow,
          openCode: runtime,
          repository: `${metadata.baseRepository.owner}/${metadata.baseRepository.name}`,
          pullRequestNumber: metadata.number,
          strategy: request.strategy,
          baseBranch: metadata.baseBranch,
          headBranch: metadata.headBranch,
          recording: () => createBoundedRecording(secrets),
          shutdownSignal: signal,
        });
      }),
      summary: createSummaryWriter(
        async (summary) => {
          await core.summary.addRaw(summary).write();
        },
        workflowRef,
        redactor,
      ),
      progress: createProgressWriter((line) => core.info(line), redactor),
      commitAndPush: (() => {
        const writer = new NodeCommitAndPush(
          git,
          request.push ? pushToken : undefined,
        );
        const assertActive = () => {
          if (signal.aborted) throw signal.reason;
        };
        return {
          commit: async (branch: string) => {
            assertActive();
            return writer.commit(branch);
          },
          beforePush: async () => {
            assertActive();
            await writer.beforePush?.();
            assertActive();
          },
          push: async (pushRequest: Parameters<typeof writer.push>[0]) => {
            assertActive();
            return writer.push(pushRequest);
          },
        };
      })(),
    };

    const result = yield* resolveMergeConflictsEffect(request, ports);
    core.setOutput("result", result.result);
    if (result.kind === "error") {
      core.setFailed(`${result.error.category}/${result.error.code}`);
      if (result.error.diagnostic !== undefined) {
        core.error(`Resolution diagnostic: ${result.error.diagnostic}`);
      }
      return;
    }
    core.setOutput("strategy", result.strategy);
    core.setOutput("base-sha", result.baseSha);
    core.setOutput("head-sha", result.headSha);
    core.setOutput("attempts", String(result.attempts));
    core.setOutput("pushed", String(result.pushed));
  });
}

function interruptible(): { readonly signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const onInt = () =>
    controller.abort(new Error("Action interrupted by SIGINT."));
  const onTerm = () =>
    controller.abort(new Error("Action interrupted by SIGTERM."));
  process.once("SIGINT", onInt);
  process.once("SIGTERM", onTerm);
  return {
    signal: controller.signal,
    dispose: () => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
    },
  };
}

export async function run(): Promise<void> {
  const { signal, dispose } = interruptible();
  let agentWorkspaceSafeToRemove = true;
  const program = Effect.gen(function* () {
    const agentRoot = yield* Effect.acquireRelease(
      Effect.uninterruptible(
        Effect.tryPromise({
          try: () =>
            mkdtemp(
              join(process.env.RUNNER_TEMP ?? tmpdir(), "seqlane-agent-"),
            ),
          catch: (cause) => cause,
        }),
      ),
      (path) =>
        !agentWorkspaceSafeToRemove
          ? Effect.sync(() =>
              core.warning(
                `Retaining temporary agent workspace because process or container termination is uncertain: ${path}`,
              ),
            )
          : Effect.tryPromise({
              try: () => rm(path, { recursive: true, force: true }),
              catch: (cause) => cause,
            }).pipe(
              Effect.catch((cause) =>
                Effect.sync(() => {
                  core.warning(
                    `Could not remove temporary agent workspace: ${cause instanceof Error ? cause.message : String(cause)}`,
                  );
                }),
              ),
            ),
    );
    yield* runAction(signal, agentRoot, () => {
      agentWorkspaceSafeToRemove = false;
    });
  });
  try {
    await Effect.runPromise(Effect.scoped(program), { signal });
  } finally {
    dispose();
  }
}

if (process.env.NODE_ENV !== "test") {
  run().catch((error: unknown) => {
    if (error instanceof ActionResolutionError) {
      core.setFailed(`${error.category}/${error.code}`);
      const diagnostic = resolutionErrorDetails(error).diagnostic;
      if (diagnostic !== undefined) {
        core.error(`Resolution diagnostic: ${diagnostic}`);
      }
      return;
    }
    core.setFailed(error instanceof Error ? error.message : "Action failed.");
  });
}
