// @test-scope ./lockfile-docker.ts
// @test-scope ./lockfile-port.ts
// @test-scope ./workspace-boundary.ts

import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  LOCKFILE_DOCKER_IMAGE,
  NodeLockfileRegenerator,
  buildDockerLockfileArguments,
  parseExactPnpmVersion,
} from "./lockfile-docker.js";
import { ActionResolutionError } from "./errors.js";
import type { GitCommandResult, GitWorkspacePort } from "./git-port.js";
import type { DockerCommandPort } from "./lockfile-port.js";

const gitResult = (stdout: string): GitCommandResult => ({
  executable: "git",
  args: [],
  cwd: "/tmp",
  exitCode: 0,
  stdout,
  stderr: "",
});

describe("lockfile Docker adapter", () => {
  it("requires an exact pnpm version", () => {
    expect(parseExactPnpmVersion({ packageManager: "pnpm@10.33.0" })).toBe(
      "10.33.0",
    );
    expect(() => parseExactPnpmVersion("pnpm@10.33")).toThrow(
      ActionResolutionError,
    );
  });

  it("builds a direct, pinned Docker argument array", () => {
    const args = buildDockerLockfileArguments({
      workspace: "/tmp/workspace with spaces",
      pnpmVersion: "10.33.0",
      uid: 1000,
      gid: 1000,
    });

    expect(args).toContain(LOCKFILE_DOCKER_IMAGE);
    expect(args.join(" ")).toContain("--lockfile-only");
    expect(args.join(" ")).toContain("--ignore-scripts");
    expect(args.join(" ")).toContain("--ignore-pnpmfile");
    expect(args.join(" ")).toContain(
      "source=/tmp/workspace with spaces,target=/workspace",
    );
  });

  it("prepares a fresh bounded workspace and copies back only the lockfile", async () => {
    const root = await mkdtemp(join(tmpdir(), "seqlane-lockfile-test-"));
    const source = join(root, "source");
    const target = join(root, "target");
    const temporaryParent = join(root, "temporary");
    await Promise.all([mkdir(source), mkdir(target), mkdir(temporaryParent)]);
    await writeFile(
      join(source, "package.json"),
      '{"packageManager":"pnpm@10.33.0"}\n',
    );
    await writeFile(join(target, "package.json"), "{}\n");
    await writeFile(join(target, "pnpm-workspace.yaml"), "packages: []\n");
    await writeFile(join(target, "pnpm-lock.yaml"), "old\n");

    const docker: DockerCommandPort = {
      run: async (request: { readonly args: readonly string[] }) => {
        const mount = request.args.find((arg) => arg.startsWith("type=bind,"));
        const workspace = mount?.match(/source=(.*),target=\/workspace/)?.[1];
        if (workspace === undefined) throw new Error("missing workspace mount");
        await writeFile(join(workspace, "pnpm-lock.yaml"), "new\n");
        return { exitCode: 0 };
      },
    };
    const git: GitWorkspacePort = {
      cwd: target,
      run: async (args: readonly string[]) =>
        args.join(" ") ===
        "ls-files -z -- pnpm-workspace.yaml :(glob)**/package.json"
          ? gitResult("pnpm-workspace.yaml\0package.json\0")
          : gitResult(""),
    };

    try {
      await new NodeLockfileRegenerator({
        targetRoot: target,
        trustedSourceRoot: source,
        temporaryParent,
        docker,
        git,
      }).regenerate(".");
      await expect(
        readFile(join(target, "pnpm-lock.yaml"), "utf8"),
      ).resolves.toBe("new\n");
      await expect(readdir(temporaryParent)).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports Docker failures as typed lockfile errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "seqlane-lockfile-error-"));
    const source = join(root, "source");
    const target = join(root, "target");
    await Promise.all([mkdir(source), mkdir(target)]);
    await writeFile(
      join(source, "package.json"),
      '{"packageManager":"pnpm@10.33.0"}\n',
    );
    await writeFile(join(target, "package.json"), "{}\n");
    try {
      await expect(
        new NodeLockfileRegenerator({
          targetRoot: target,
          trustedSourceRoot: source,
          docker: { run: async () => ({ exitCode: 17, stderr: "failed" }) },
          git: { cwd: target, run: async () => gitResult("package.json\0") },
        }).regenerate("."),
      ).rejects.toMatchObject({
        category: "lockfile",
        code: "LOCKFILE_REGENERATION_FAILED",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects overlapping roots before reading trusted package metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "seqlane-lockfile-overlap-"));
    const source = join(root, "source");
    await mkdir(source);
    let dockerCalls = 0;
    try {
      await expect(
        new NodeLockfileRegenerator({
          targetRoot: source,
          trustedSourceRoot: source,
          docker: {
            run: async () => {
              dockerCalls += 1;
              return { exitCode: 0 };
            },
          },
        }).regenerate("."),
      ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
      expect(dockerCalls).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects symlink roots and source-directory escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "seqlane-lockfile-symlink-"));
    const source = join(root, "source");
    const target = join(root, "target");
    const outside = join(root, "outside");
    const sourceLink = join(root, "source-link");
    await Promise.all([mkdir(source), mkdir(target), mkdir(outside)]);
    await symlink(source, sourceLink, "dir");
    await writeFile(
      join(source, "package.json"),
      '{"packageManager":"pnpm@10.33.0"}\n',
    );
    await writeFile(
      join(outside, "package.json"),
      '{"packageManager":"pnpm@10.33.0"}\n',
    );
    await symlink(outside, join(source, "linked"), "dir");
    try {
      await expect(
        new NodeLockfileRegenerator({
          targetRoot: target,
          trustedSourceRoot: sourceLink,
        }).regenerate("."),
      ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
      await expect(
        new NodeLockfileRegenerator({
          targetRoot: target,
          trustedSourceRoot: source,
        }).regenerate("linked"),
      ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
