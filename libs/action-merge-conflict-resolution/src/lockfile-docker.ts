import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { z } from "zod";

import {
  relativeDirectorySchema,
  type RelativeDirectory,
} from "./contracts.js";
import { ActionResolutionError } from "./errors.js";
import { NodeGitCli } from "./git-cli.js";
import { type GitWorkspacePort } from "./git-port.js";
import {
  type DockerCommandPort,
  type DockerCommandRequest,
  type DockerCommandResult,
  type LockfileRegenerationPort,
} from "./lockfile-port.js";
import { prepareLockfileWorkspace } from "./workspace-boundary.js";

export const LOCKFILE_DOCKER_IMAGE =
  "node@sha256:6642ef280aebc09c4541bee0b15c9f89f0f3f3c247ddee79ae1d37eddfdcbbaa";
export const LOCKFILE_DOCKER_WORKDIR = "/workspace";
export const LOCKFILE_DOCKER_HOME = "/tmp/seqlane-home";
export const LOCKFILE_DOCKER_COREPACK_HOME = "/tmp/seqlane-corepack";
export const LOCKFILE_DOCKER_REGISTRY = "https://registry.npmjs.org/";
export const LOCKFILE_DOCKER_SCRIPT =
  'mkdir -p "$HOME" "$COREPACK_HOME" && COREPACK_ENABLE_PROJECT_SPEC=0 COREPACK_NPM_REGISTRY=https://registry.npmjs.org corepack install --global "pnpm@$PNPM_VERSION" && test "$(COREPACK_ENABLE_PROJECT_SPEC=0 corepack pnpm --version)" = "$PNPM_VERSION" && COREPACK_ENABLE_PROJECT_SPEC=0 corepack pnpm install --config.registry=https://registry.npmjs.org/ --lockfile-only --ignore-scripts --ignore-pnpmfile';

const exactPnpmVersionSchema = z.string().regex(/^pnpm@(\d+\.\d+\.\d+)$/);
const packageManifestSchema = z.object({
  packageManager: exactPnpmVersionSchema,
});

const lockfileError = (
  message: string,
  cause?: unknown,
): ActionResolutionError =>
  new ActionResolutionError(
    "lockfile",
    "LOCKFILE_REGENERATION_FAILED",
    message,
    cause,
  );

export function parseExactPnpmVersion(value: unknown): string {
  const packageManager =
    typeof value === "string"
      ? exactPnpmVersionSchema.safeParse(value)
      : (() => {
          const manifest = packageManifestSchema.safeParse(value);
          return manifest.success
            ? exactPnpmVersionSchema.safeParse(manifest.data.packageManager)
            : manifest;
        })();

  if (packageManager?.success !== true) {
    throw lockfileError(
      "The trusted package.json must declare pnpm with an exact version.",
      packageManager?.error,
    );
  }
  return packageManager.data.slice("pnpm@".length);
}

export async function readExactPnpmVersion(
  packageJsonPath: string,
): Promise<string> {
  let document: unknown;
  try {
    document = JSON.parse(await readFile(packageJsonPath, "utf8"));
  } catch (error: unknown) {
    throw lockfileError(
      "The trusted package.json could not be read as JSON.",
      error,
    );
  }
  return parseExactPnpmVersion(document);
}

export interface DockerLockfileArguments {
  readonly workspace: string;
  readonly pnpmVersion: string;
  readonly uid: number;
  readonly gid: number;
  readonly image?: string;
}

export function buildDockerLockfileArguments(
  options: DockerLockfileArguments,
): readonly string[] {
  const pnpmVersion = parseExactPnpmVersion(`pnpm@${options.pnpmVersion}`);
  const image = options.image ?? LOCKFILE_DOCKER_IMAGE;
  return [
    "run",
    "--rm",
    "--network",
    "bridge",
    "--user",
    `${options.uid}:${options.gid}`,
    "--env",
    `HOME=${LOCKFILE_DOCKER_HOME}`,
    "--env",
    `COREPACK_HOME=${LOCKFILE_DOCKER_COREPACK_HOME}`,
    "--env",
    `PNPM_VERSION=${pnpmVersion}`,
    "--mount",
    `type=bind,source=${resolve(options.workspace)},target=${LOCKFILE_DOCKER_WORKDIR}`,
    "--workdir",
    LOCKFILE_DOCKER_WORKDIR,
    image,
    "sh",
    "-c",
    LOCKFILE_DOCKER_SCRIPT,
  ];
}

export function runDockerCommand(
  request: DockerCommandRequest,
): Promise<DockerCommandResult> {
  return new Promise((resolveResult) => {
    execFile(
      request.executable,
      [...request.args],
      {
        cwd: request.cwd,
        env: { ...process.env, ...request.env },
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      },
      (error, _stdout, stderr) => {
        resolveResult({
          exitCode:
            error === null
              ? 0
              : typeof error.code === "number"
                ? error.code
                : 1,
          stderr,
        });
      },
    );
  });
}

export interface NodeLockfileRegeneratorOptions {
  /** The checkout whose manifests are regenerated. */
  readonly targetRoot: string;
  /** Trusted source checkout used only to read packageManager. */
  readonly trustedSourceRoot: string;
  readonly temporaryParent?: string;
  readonly docker?: DockerCommandPort;
  readonly git?: GitWorkspacePort;
  readonly dockerExecutable?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly uid?: number;
  readonly gid?: number;
  readonly image?: string;
}

function currentUserId(
  value: number | undefined,
  getter: () => number,
): number {
  return value ?? getter();
}

async function copyGeneratedLockfile(
  workspace: string,
  targetRoot: string,
): Promise<void> {
  const source = join(workspace, "pnpm-lock.yaml");
  const target = join(targetRoot, "pnpm-lock.yaml");
  try {
    const sourceDetails = await lstat(source);
    if (!sourceDetails.isFile() || sourceDetails.isSymbolicLink()) {
      throw lockfileError("Docker did not produce a regular lockfile.");
    }
    const targetDetails = await lstat(target).catch((error: unknown) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    });
    if (targetDetails?.isSymbolicLink()) {
      throw lockfileError("The target lockfile must not be a symbolic link.");
    }
    await writeFile(target, await readFile(source), { flag: "w" });
  } catch (error: unknown) {
    if (error instanceof ActionResolutionError) throw error;
    throw lockfileError(
      "The generated lockfile could not be copied back.",
      error,
    );
  }
}

export class NodeLockfileRegenerator implements LockfileRegenerationPort {
  private readonly targetRoot: string;
  private readonly trustedSourceRoot: string;
  private readonly temporaryParent: string;
  private readonly docker: DockerCommandPort;
  private readonly git: GitWorkspacePort;
  private readonly options: NodeLockfileRegeneratorOptions;

  constructor(options: NodeLockfileRegeneratorOptions) {
    this.options = options;
    this.targetRoot = resolve(options.targetRoot);
    this.trustedSourceRoot = resolve(options.trustedSourceRoot);
    this.temporaryParent = resolve(options.temporaryParent ?? tmpdir());
    this.docker = options.docker ?? { run: runDockerCommand };
    this.git = options.git ?? new NodeGitCli(this.targetRoot);
  }

  async regenerate(sourceDirectory: RelativeDirectory): Promise<void> {
    const parsedDirectory = relativeDirectorySchema.safeParse(sourceDirectory);
    if (!parsedDirectory.success) {
      throw lockfileError(
        "The trusted source directory is malformed.",
        parsedDirectory.error,
      );
    }

    const pnpmVersion = await readExactPnpmVersion(
      join(this.trustedSourceRoot, parsedDirectory.data, "package.json"),
    );
    const workspace = await mkdtemp(
      join(this.temporaryParent, ".seqlane-lockfile-"),
    );
    try {
      await prepareLockfileWorkspace(this.targetRoot, workspace, this.git);

      const request: DockerCommandRequest = {
        executable: this.options.dockerExecutable ?? "docker",
        args: buildDockerLockfileArguments({
          workspace,
          pnpmVersion,
          uid: currentUserId(this.options.uid, () => process.getuid?.() ?? 0),
          gid: currentUserId(this.options.gid, () => process.getgid?.() ?? 0),
          image: this.options.image,
        }),
        cwd: resolve(this.options.cwd ?? this.targetRoot),
        env: { ...this.options.env },
      };
      const result = await this.docker.run(request);
      if (result.exitCode !== 0) {
        throw lockfileError(
          "The Docker lockfile regeneration command failed.",
          result.stderr,
        );
      }
      await copyGeneratedLockfile(workspace, this.targetRoot);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }
}

export class NodeLockfileDockerAdapter extends NodeLockfileRegenerator {}
