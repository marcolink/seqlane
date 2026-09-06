import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import * as core from "@actions/core";
import * as github from "@actions/github";
import {
  GitHubMetadataAdapter,
  NodeCommitAndPush,
  NodeGitCli,
  NodeLockfileRegenerator,
  NodeOpenCodeRuntime,
  NodeWorkspaceBoundary,
  createSeqlaneAgentRunner,
  createSummaryWriter,
  parseActionInputs,
  resolveMergeConflicts,
  workflowDefinitionMetadata,
  type AgentRunnerPort,
  type PullRequestMetadata,
  type WorkspaceFilesPort,
} from "@seqlane/action-merge-conflict-resolution";
import workflow from "@seqlane/runtime/workflows/resolve-merge-conflicts";

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
  const secret = process.env.OPENAI_API_KEY;
  if (secret !== undefined && secret.length > 0) core.setSecret(secret);

  const request = parseActionInputs({
    pullRequestNumber: core.getInput("pull-request-number", { required: true }),
    resolutionStrategy: core.getInput("resolution-strategy"),
    sourceDirectory: core.getInput("source-directory"),
    targetDirectory: core.getInput("target-directory"),
    commit: core.getInput("commit"),
    push: core.getInput("push"),
    maxAttempts: core.getInput("max-attempts"),
  });
  const root = requiredWorkspace();
  const sourceRoot = resolve(root, request.sourceDirectory);
  const targetRoot = resolve(root, request.targetDirectory);
  const agentRoot = await mkdtemp(
    join(process.env.RUNNER_TEMP ?? tmpdir(), "seqlane-agent-"),
  );
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";
  const octokit = github.getOctokit(token);
  const workflowRef = workflowMetadata();
  let metadata: PullRequestMetadata | undefined;
  let boundary: NodeWorkspaceBoundary | undefined;
  let agent: AgentRunnerPort | undefined;
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
    });
    return boundary;
  };
  const files: WorkspaceFilesPort = {
    prepareAgentWorkspace: async (conflicts) => {
      return getBoundary().prepareAgentWorkspace(conflicts);
    },
    copyAgentEdits: async (paths) => getBoundary().copyAgentEdits(paths),
    validateTarget: async (conflicts) =>
      getBoundary().validateTarget(conflicts),
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
      trustedSourceRoot: root,
    }),
    agent: {
      resolve: async (
        agentRequest: Parameters<AgentRunnerPort["resolve"]>[0],
      ) => {
        if (metadata === undefined)
          throw new Error("Pull-request metadata is unavailable.");
        agent ??= createSeqlaneAgentRunner({
          workspace: agentRoot,
          workflow,
          openCode: runtime,
          repository: `${metadata.baseRepository.owner}/${metadata.baseRepository.name}`,
          pullRequestNumber: metadata.number,
          strategy: request.strategy,
          baseBranch: metadata.baseBranch,
          headBranch: metadata.headBranch,
        });
        await agent.resolve(agentRequest);
      },
    },
    summary: createSummaryWriter(async (summary) => {
      await core.summary.addRaw(summary).write();
    }, workflowRef),
    commitAndPush: new NodeCommitAndPush(git, token),
  };

  try {
    const result = await resolveMergeConflicts(request, ports);
    core.setOutput("result", result.result);
    if (result.kind === "error") {
      core.setFailed(`${result.error.category}/${result.error.code}`);
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
    core.setFailed(error instanceof Error ? error.message : "Action failed.");
  });
}
