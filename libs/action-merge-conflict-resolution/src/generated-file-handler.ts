import { lstatSync, readlinkSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

import {
  type ConflictPath,
  type ConflictSet,
  type ConflictHandlerRule,
  type GeneratedFileHandlerPort,
} from "./contracts.js";
import { ActionResolutionError } from "./errors.js";
import {
  assertSafeRoot,
  copyFiles,
  readWorkspaceChangePaths,
} from "./workspace-boundary.js";
import type { GitWorkspacePort } from "./git-port.js";
import {
  validateGeneratedOutputPath,
  matchesGeneratedFileGlob,
} from "./generated-file-policy.js";
import {
  type DockerCommandPort,
  type DockerCommandRequest,
  type DockerCommandResult,
} from "./lockfile-port.js";
import { LOCKFILE_DOCKER_IMAGE, runDockerCommand } from "./lockfile-docker.js";
import { NodeGitCli } from "./git-cli.js";

export const GENERATED_FILE_DOCKER_WORKDIR = "/workspace";
export const GENERATED_FILE_DOCKER_HOME = "/tmp/seqlane-home";
export const GENERATED_FILE_DOCKER_COREPACK_HOME = "/tmp/seqlane-corepack";
export const GENERATED_FILE_DOCKER_TIMEOUT_MS = 10 * 60 * 1000;

type GeneratedFileDockerNetwork = "none" | "bridge";

export interface GeneratedFileDockerArguments {
  readonly workspace: string;
  readonly command: readonly string[];
  readonly uid: number;
  readonly gid: number;
  readonly image?: string;
  readonly network?: GeneratedFileDockerNetwork;
  readonly corepackHome?: string;
}

export function buildDockerGeneratedFileArguments(
  options: GeneratedFileDockerArguments,
): readonly string[] {
  const image = options.image ?? LOCKFILE_DOCKER_IMAGE;
  return [
    "run",
    "--rm",
    "--network",
    options.network ?? "none",
    "--user",
    `${options.uid}:${options.gid}`,
    "--env",
    `HOME=${GENERATED_FILE_DOCKER_HOME}`,
    "--env",
    `COREPACK_HOME=${GENERATED_FILE_DOCKER_COREPACK_HOME}`,
    "--env",
    "COREPACK_ENABLE_PROJECT_SPEC=0",
    "--env",
    "COREPACK_NPM_REGISTRY=https://registry.npmjs.org",
    "--env",
    "CI=true",
    "--mount",
    `type=bind,source=${resolve(options.corepackHome ?? options.workspace)},target=${GENERATED_FILE_DOCKER_COREPACK_HOME}`,
    "--mount",
    `type=bind,source=${resolve(options.workspace)},target=${GENERATED_FILE_DOCKER_WORKDIR}`,
    "--workdir",
    GENERATED_FILE_DOCKER_WORKDIR,
    image,
    ...options.command,
  ];
}

function currentUserId(
  value: number | undefined,
  getter: () => number,
): number {
  return value ?? getter();
}

function generatedHandlerError(message: string, cause?: unknown) {
  return new ActionResolutionError(
    "operational",
    "CONFLICT_HANDLER_FAILED",
    message,
    cause,
  );
}

function safeHandlerEnvironment(
  value: Readonly<Record<string, string | undefined>> | undefined,
): Readonly<Record<string, string | undefined>> {
  // The Docker CLI process must not inherit action credentials or other
  // secrets from a caller-provided environment. The container receives its
  // required values through the explicit, non-sensitive Docker arguments.
  const allowed = new Set(["PATH", "LANG", "LC_ALL", "TMPDIR"]);
  return Object.fromEntries(
    Object.entries(value ?? {}).filter(
      ([key, environmentValue]) =>
        allowed.has(key) && environmentValue !== undefined,
    ),
  );
}

export interface NodeGeneratedFileHandlerOptions {
  readonly targetRoot: string;
  readonly temporaryParent?: string;
  readonly docker?: DockerCommandPort;
  readonly git?: GitWorkspacePort;
  readonly dockerExecutable?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly uid?: number;
  readonly gid?: number;
  readonly image?: string;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path.length === 0 || (!path.startsWith(`..${sep}`) && path !== "..");
}

function isGitMetadataPath(root: string, candidate: string): boolean {
  return relative(root, candidate).split(sep).includes(".git");
}

async function copyTargetWorkspace(
  sourceRoot: string,
  outputRoot: string,
): Promise<void> {
  await cp(sourceRoot, outputRoot, {
    recursive: true,
    force: false,
    filter: (source) => {
      if (basename(source) === ".git") return false;
      try {
        const details = lstatSync(source);
        if (!details.isSymbolicLink()) return true;
        const target = resolve(dirname(source), readlinkSync(source));
        return (
          isWithinRoot(sourceRoot, target) &&
          !isGitMetadataPath(sourceRoot, target)
        );
      } catch {
        return false;
      }
    },
  });
}

async function listRegularFiles(
  root: string,
): Promise<readonly ConflictPath[]> {
  const files: ConflictPath[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        files.push(relative(root, path).split(sep).join("/") as ConflictPath);
      }
    }
  }
  await walk(root);
  return files;
}

async function createHandlerWorkspace(
  targetRoot: string,
  temporaryParent: string,
): Promise<string> {
  if (isWithinRoot(targetRoot, temporaryParent)) {
    throw generatedHandlerError(
      "The generated-file workspace must be outside the resolution target.",
    );
  }
  try {
    return await mkdtemp(join(temporaryParent, ".seqlane-generated-handler-"));
  } catch (error: unknown) {
    throw generatedHandlerError(
      "The generated-file workspace could not be created.",
      error,
    );
  }
}

interface DockerHandlerExecution {
  readonly docker: DockerCommandPort;
  readonly request: DockerCommandRequest;
  readonly workspace: string;
  readonly corepackHome: string;
  readonly uid: number;
  readonly gid: number;
  readonly image?: string;
}

async function runDockerHandlerCommand(
  execution: DockerHandlerExecution,
  command: readonly string[],
  network: GeneratedFileDockerNetwork,
): Promise<void> {
  let result: DockerCommandResult;
  try {
    result = await execution.docker.run({
      ...execution.request,
      args: buildDockerGeneratedFileArguments({
        workspace: execution.workspace,
        corepackHome: execution.corepackHome,
        command,
        uid: execution.uid,
        gid: execution.gid,
        image: execution.image,
        network,
      }),
    });
  } catch (error: unknown) {
    throw generatedHandlerError(
      "The generated-file handler could not start.",
      error,
    );
  }
  if (result.exitCode !== 0) {
    throw generatedHandlerError(
      "The generated-file handler command failed.",
      result.stderr,
    );
  }
}

async function runHandlerCommands(
  rule: ConflictHandlerRule,
  execution: DockerHandlerExecution,
): Promise<void> {
  const commands = [
    ...(rule.handler.setup ?? []).map((command) => ({
      command,
      network: "bridge" as const,
    })),
    { command: rule.handler.command, network: "none" as const },
  ];
  for (const { command, network } of commands) {
    await runDockerHandlerCommand(execution, command, network);
  }
}

async function collectGeneratedOutputs(
  workspace: string,
  rule: ConflictHandlerRule,
  conflicts: ConflictSet,
): Promise<readonly ConflictPath[]> {
  const generatedFiles = (await listRegularFiles(workspace)).filter((path) =>
    validateGeneratedOutputPath(path, rule),
  );
  const missing = conflicts
    .map(({ path }) => path)
    .filter((path) => !generatedFiles.includes(path));
  if (missing.length > 0) {
    throw generatedHandlerError(
      `The generated-file handler did not produce all conflicted outputs: ${missing.join(", ")}.`,
    );
  }
  return generatedFiles;
}

async function copyGeneratedOutputs(
  workspace: string,
  targetRoot: string,
  generatedFiles: readonly ConflictPath[],
): Promise<void> {
  await copyFiles(
    { sourceRoot: workspace, outputRoot: targetRoot },
    generatedFiles,
    {
      maximumFileBytes: 16 * 1024 * 1024,
      maximumTotalBytes: 64 * 1024 * 1024,
    },
  );
}

async function validateGeneratedChanges(
  git: GitWorkspacePort,
  before: ReadonlySet<ConflictPath>,
  conflicts: ConflictSet,
  rule: ConflictHandlerRule,
): Promise<readonly ConflictPath[]> {
  const changed = await readWorkspaceChangePaths(git);
  const unexpected = changed.filter(
    (path) => !before.has(path) && !validateGeneratedOutputPath(path, rule),
  );
  if (unexpected.length > 0) {
    throw generatedHandlerError(
      `The generated-file handler changed paths outside its outputs: ${unexpected.join(", ")}.`,
    );
  }
  const outputs = changed.filter((path) =>
    validateGeneratedOutputPath(path, rule),
  );
  const missing = conflicts
    .map(({ path }) => path)
    .filter((path) => !outputs.includes(path));
  if (missing.length > 0) {
    throw generatedHandlerError(
      `The generated-file handler did not produce all conflicted outputs: ${missing.join(", ")}.`,
    );
  }
  return outputs;
}

function assertConflictOutputs(
  rule: ConflictHandlerRule,
  conflicts: ConflictSet,
): void {
  for (const conflict of conflicts) {
    if (
      !rule.outputs.some((output) =>
        matchesGeneratedFileGlob(output, conflict.path),
      )
    ) {
      throw generatedHandlerError(
        `Handler output policy does not include conflict path: ${conflict.path}.`,
      );
    }
  }
}

async function runGeneratedFileHandler(
  context: {
    readonly targetRoot: string;
    readonly options: NodeGeneratedFileHandlerOptions;
    readonly docker: DockerCommandPort;
    readonly git: GitWorkspacePort;
  },
  rule: ConflictHandlerRule,
  conflicts: ConflictSet,
): Promise<readonly ConflictPath[]> {
  const { targetRoot, options, docker, git } = context;
  const safeTargetRoot = await assertSafeRoot(targetRoot, "Resolution target");
  assertConflictOutputs(rule, conflicts);
  const before = new Set(await readWorkspaceChangePaths(git));
  const temporaryParent = resolve(options.temporaryParent ?? tmpdir());
  const handlerWorkspace = await createHandlerWorkspace(
    safeTargetRoot,
    temporaryParent,
  );
  try {
    await copyTargetWorkspace(safeTargetRoot, handlerWorkspace);
    const corepackHome = join(handlerWorkspace, ".seqlane-corepack");
    await mkdir(corepackHome);
    const request: DockerCommandRequest = {
      executable: options.dockerExecutable ?? "docker",
      args: [],
      cwd: resolve(options.cwd ?? safeTargetRoot),
      env: safeHandlerEnvironment(options.env),
      timeoutMs: options.timeoutMs ?? GENERATED_FILE_DOCKER_TIMEOUT_MS,
    };
    await runHandlerCommands(rule, {
      docker,
      request,
      workspace: handlerWorkspace,
      corepackHome,
      uid: currentUserId(options.uid, () => process.getuid?.() ?? 0),
      gid: currentUserId(options.gid, () => process.getgid?.() ?? 0),
      image: options.image,
    });
    const generatedFiles = await collectGeneratedOutputs(
      handlerWorkspace,
      rule,
      conflicts,
    );
    await copyGeneratedOutputs(
      handlerWorkspace,
      safeTargetRoot,
      generatedFiles,
    );
    return await validateGeneratedChanges(git, before, conflicts, rule);
  } finally {
    await rm(handlerWorkspace, { recursive: true, force: true });
  }
}

export class NodeGeneratedFileHandler implements GeneratedFileHandlerPort {
  private readonly targetRoot: string;
  private readonly docker: DockerCommandPort;
  private readonly git: GitWorkspacePort;
  private readonly options: NodeGeneratedFileHandlerOptions;

  constructor(options: NodeGeneratedFileHandlerOptions) {
    this.options = options;
    this.targetRoot = resolve(options.targetRoot);
    this.docker = options.docker ?? { run: runDockerCommand };
    this.git = options.git ?? new NodeGitCli(this.targetRoot);
  }

  async run(
    rule: ConflictHandlerRule,
    conflicts: ConflictSet,
  ): Promise<readonly ConflictPath[]> {
    return runGeneratedFileHandler(
      {
        targetRoot: this.targetRoot,
        options: this.options,
        docker: this.docker,
        git: this.git,
      },
      rule,
      conflicts,
    );
  }
}
