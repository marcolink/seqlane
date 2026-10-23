import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Effect } from "effect";
import {
  GitHubMetadataAdapter,
  NodeCommitAndPush,
  NodeGeneratedFileHandler,
  NodeGitCli,
  NodeLockfileRegenerator,
  NodeOpenCodeRuntime,
  NodeWorkspaceBoundary,
  createBoundedRecording,
  createProgressWriter,
  createSecretRedactor,
  createSeqlaneAgentRunner,
  createSummaryWriter,
  resolveMergeConflictsEffect,
  validateSeparateWorkspaceRoots,
  type AgentRunnerPort,
  type GitHubMetadataClient,
  type PullRequestMetadata,
  type RepositoryIdentity,
  type ResolveMergeConflictsRequest,
  type WorkflowDefinitionMetadata,
  type WorkspaceFilesPort,
} from "@seqlane/action-merge-conflict-resolution";
import workflow from "@seqlane/resolve-merge-conflicts-workflow";
import { createLazyAgentPort } from "./lazy-agent-port.js";

interface ResolverActionContext {
  readonly signal: AbortSignal;
  readonly workspaceRoot: string;
  readonly runnerTemporaryDirectory: string | undefined;
  readonly repository: RepositoryIdentity;
  readonly workflow: WorkflowDefinitionMetadata | undefined;
  readonly skillDirectory: string;
}

interface ResolverActionCallbacks {
  readonly info: (line: string) => void;
  readonly warning: (message: string) => void;
  readonly writeSummary: (summary: string) => Promise<void>;
}

interface ComposeResolverActionOptions {
  readonly request: ResolveMergeConflictsRequest;
  readonly pushToken: string;
  readonly secrets: readonly string[];
  readonly client: GitHubMetadataClient;
  readonly context: ResolverActionContext;
  readonly callbacks: ResolverActionCallbacks;
}

interface ResolverPortContext {
  readonly options: ComposeResolverActionOptions;
  readonly sourceRoot: string;
  readonly targetRoot: string;
  readonly agentRoot: string;
  readonly markAgentWorkspaceUnsafe: () => void;
  readonly metadata: () => PullRequestMetadata;
  readonly git: NodeGitCli;
  readonly runtime: NodeOpenCodeRuntime;
}

function acquireAgentWorkspace(options: ComposeResolverActionOptions) {
  let safeToRemove = true;
  return Effect.acquireRelease(
    Effect.uninterruptible(
      Effect.tryPromise({
        try: () =>
          mkdtemp(
            join(
              options.context.runnerTemporaryDirectory ?? tmpdir(),
              "seqlane-agent-",
            ),
          ),
        catch: (cause) => cause,
      }),
    ),
    (path) =>
      !safeToRemove
        ? Effect.sync(() =>
            options.callbacks.warning(
              `Retaining temporary agent workspace because process or container termination is uncertain: ${path}`,
            ),
          )
        : Effect.tryPromise({
            try: () => rm(path, { recursive: true, force: true }),
            catch: (cause) => cause,
          }).pipe(
            Effect.catch((cause) =>
              Effect.sync(() => {
                options.callbacks.warning(
                  `Could not remove temporary agent workspace: ${cause instanceof Error ? cause.message : String(cause)}`,
                );
              }),
            ),
          ),
  ).pipe(
    Effect.map((root) => ({
      root,
      markUnsafe: () => {
        safeToRemove = false;
      },
    })),
  );
}

function createWorkspaceFiles(
  context: ResolverPortContext,
): WorkspaceFilesPort {
  let boundary: NodeWorkspaceBoundary | undefined;
  const getBoundary = () => {
    const metadata = context.metadata();
    boundary ??= new NodeWorkspaceBoundary({
      sourceRoot: context.sourceRoot,
      targetRoot: context.targetRoot,
      agentRoot: context.agentRoot,
      baseRevision: metadata.baseRevision,
      headRevision: metadata.headRevision,
      git: context.git,
    });
    return boundary;
  };
  return {
    captureIntegrationBaseline: async () =>
      getBoundary().captureIntegrationBaseline(),
    prepareAgentWorkspace: async (conflicts) =>
      getBoundary().prepareAgentWorkspace(conflicts),
    copyAgentEdits: async (paths) => getBoundary().copyAgentEdits(paths),
    validateTarget: async (conflicts, generatedPaths) =>
      getBoundary().validateTarget(conflicts, generatedPaths),
  };
}

function createAgentPort(context: ResolverPortContext): AgentRunnerPort {
  return createLazyAgentPort(() => {
    const metadata = context.metadata();
    return createSeqlaneAgentRunner({
      workspace: context.agentRoot,
      workflow,
      openCode: context.runtime,
      repository: `${metadata.baseRepository.owner}/${metadata.baseRepository.name}`,
      pullRequestNumber: metadata.number,
      strategy: context.options.request.strategy,
      baseBranch: metadata.baseBranch,
      headBranch: metadata.headBranch,
      recording: () => createBoundedRecording(context.options.secrets),
      shutdownSignal: context.options.context.signal,
    });
  });
}

function createCommitAndPushPort(context: ResolverPortContext) {
  const { request } = context.options;
  const writer = new NodeCommitAndPush(
    context.git,
    request.push ? context.options.pushToken : undefined,
  );
  const assertActive = () => {
    if (context.options.context.signal.aborted) {
      throw context.options.context.signal.reason;
    }
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
}

function createResolverPorts(
  context: ResolverPortContext,
  metadataValue: { value: PullRequestMetadata | undefined },
) {
  const { options, sourceRoot, targetRoot, git } = context;
  const redactor = createSecretRedactor(options.secrets);
  const githubAdapter = new GitHubMetadataAdapter({
    signal: options.context.signal,
    repository: options.context.repository,
    workflow: options.context.workflow,
    client: options.client,
  });
  const ports = {
    github: {
      readPullRequest: async (number: number) => {
        metadataValue.value = await githubAdapter.readPullRequest(number);
        return metadataValue.value;
      },
      readLiveBaseRevision: (
        branch: Parameters<typeof githubAdapter.readLiveBaseRevision>[0],
      ) => githubAdapter.readLiveBaseRevision(branch),
    },
    git,
    files: createWorkspaceFiles(context),
    lockfile: new NodeLockfileRegenerator({
      targetRoot,
      trustedSourceRoot: sourceRoot,
      signal: options.context.signal,
      onUncertain: context.markAgentWorkspaceUnsafe,
    }),
    generatedFiles: new NodeGeneratedFileHandler({
      targetRoot,
      git,
      signal: options.context.signal,
      onUncertain: context.markAgentWorkspaceUnsafe,
    }),
    agent: createAgentPort(context),
    summary: createSummaryWriter(
      options.callbacks.writeSummary,
      options.context.workflow,
      redactor,
    ),
    progress: createProgressWriter(options.callbacks.info, redactor),
    commitAndPush: createCommitAndPushPort(context),
  };
  return ports;
}

export function composeResolverAction(options: ComposeResolverActionOptions) {
  return Effect.gen(function* () {
    const workspace = yield* acquireAgentWorkspace(options);
    const { sourceRoot, targetRoot } = yield* Effect.uninterruptible(
      Effect.tryPromise({
        try: () =>
          validateSeparateWorkspaceRoots(
            resolve(
              options.context.workspaceRoot,
              options.request.sourceDirectory,
            ),
            resolve(
              options.context.workspaceRoot,
              options.request.targetDirectory,
            ),
          ),
        catch: (cause) => cause,
      }),
    );
    const metadataValue: { value: PullRequestMetadata | undefined } = {
      value: undefined,
    };
    const portsContext: ResolverPortContext = {
      options,
      sourceRoot,
      targetRoot,
      agentRoot: workspace.root,
      markAgentWorkspaceUnsafe: workspace.markUnsafe,
      metadata: () => {
        if (metadataValue.value === undefined) {
          throw new Error("Pull-request metadata is unavailable.");
        }
        return metadataValue.value;
      },
      git: new NodeGitCli(
        targetRoot,
        "git",
        options.context.signal,
        workspace.markUnsafe,
      ),
      runtime: new NodeOpenCodeRuntime({
        skillDirectory: options.context.skillDirectory,
        onUncertain: workspace.markUnsafe,
      }),
    };
    const ports = createResolverPorts(portsContext, metadataValue);
    return yield* resolveMergeConflictsEffect(options.request, ports);
  });
}
