import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import "./require-shim.js";

import * as core from "@actions/core";
import * as github from "@actions/github";
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
  createSummaryWriter,
  parseActionInputs,
  ActionResolutionError,
  resolutionErrorDetails,
  resolveMergeConflicts,
  workflowDefinitionMetadata,
  type PullRequestMetadata,
  type WorkspaceFilesPort,
  validateSeparateWorkspaceRoots,
} from "@seqlane/action-merge-conflict-resolution";
import workflow from "@seqlane/runtime/workflows/resolve-merge-conflicts";
import { createLazyAgentPort } from "./lazy-agent-port.js";

function requiredWorkspace(): string {
  const value = process.env.GITHUB_WORKSPACE;
  if (value === undefined || value.length === 0) {
    throw new Error("GITHUB_WORKSPACE is required.");
  }
  return resolve(value);
}

function workflowMetadata() {
  const ref = process.env.GITHUB_WORKFLOW_REF ?? github.context.ref;
  const sha = process.env.GITHUB_WORKFLOW_SHA ?? github.context.sha;
  if (ref.length === 0 || sha.length === 0) return undefined;
  return workflowDefinitionMetadata(ref, sha);
}

export async function run(): Promise<void> {
  const secrets = [
    process.env.OPENAI_API_KEY,
    process.env.GITHUB_TOKEN,
    process.env.GH_TOKEN,
  ].filter((value): value is string => value !== undefined && value.length > 0);
  for (const secret of secrets) core.setSecret(secret);

  const actionRequest = parseActionInputs({
    pullRequestNumber: core.getInput("pull-request-number", { required: true }),
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
  const { sourceRoot, targetRoot } = await validateSeparateWorkspaceRoots(
    resolve(root, actionRequest.sourceDirectory),
    resolve(root, actionRequest.targetDirectory),
  );
  const request = actionRequest;
  const agentRoot = await mkdtemp(
    join(process.env.RUNNER_TEMP ?? tmpdir(), "seqlane-agent-"),
  );
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";
  const octokit = github.getOctokit(token);
  const workflowRef = workflowMetadata();
  const redactor = createSecretRedactor(secrets);
  let metadata: PullRequestMetadata | undefined;
  let boundary: NodeWorkspaceBoundary | undefined;
  const git = new NodeGitCli(targetRoot);
  const githubAdapter = new GitHubMetadataAdapter({
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
          })
        ).data,
      getBranchRef: async (value) =>
        (
          await octokit.rest.git.getRef({
            owner: value.owner,
            repo: value.repository,
            ref: value.ref,
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
  const runtime = new NodeOpenCodeRuntime();
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
    }),
    generatedFiles: new NodeGeneratedFileHandler({ targetRoot, git }),
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
      });
    }),
    summary: createSummaryWriter(
      async (summary) => {
        await core.summary.addRaw(summary).write();
      },
      workflowRef,
      redactor,
    ),
    commitAndPush: new NodeCommitAndPush(
      git,
      request.push ? pushToken : undefined,
    ),
  };

  try {
    const result = await resolveMergeConflicts(request, ports);
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
  } finally {
    await rm(agentRoot, { recursive: true, force: true });
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
