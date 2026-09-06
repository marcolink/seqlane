// @test-scope ./commit-and-push.ts

import { describe, expect, it } from "vitest";

import { NodeCommitAndPush } from "./commit-and-push.js";
import type { GitWorkspacePort } from "./git-port.js";

const revision = (letter: string): string => letter.repeat(40);

describe("commit and push adapter", () => {
  it("configures local identity and uses the exact lease push", async () => {
    const commands: readonly string[][] = [];
    const git: GitWorkspacePort = {
      cwd: "/tmp/target",
      run: async (args) => {
        (commands as string[][]).push([...args]);
        const stdout =
          args[0] === "rev-parse" && args.at(-1)?.endsWith("main")
            ? revision("c")
            : args[0] === "rev-parse"
              ? revision("b")
              : "";
        return {
          executable: "git",
          args,
          cwd: "/tmp/target",
          exitCode: 0,
          stdout,
          stderr: "",
        };
      },
    };
    await new NodeCommitAndPush(git).commit("main");
    await new NodeCommitAndPush(git).push({
      baseBranch: "main",
      headBranch: "feature",
      baseRevision: revision("c"),
      headRevision: revision("b"),
    });

    expect(commands).toContainEqual([
      "config",
      "user.name",
      "Seqlane conflict resolver",
    ]);
    expect(commands).toContainEqual([
      "push",
      `--force-with-lease=refs/heads/feature:${revision("b")}`,
      "origin",
      "HEAD:refs/heads/feature",
    ]);
  });

  it("rejects a changed remote head before push", async () => {
    const git: GitWorkspacePort = {
      cwd: "/tmp/target",
      run: async (args) => ({
        executable: "git",
        args,
        cwd: "/tmp/target",
        exitCode: 0,
        stdout: args[0] === "rev-parse" ? revision("d") : "",
        stderr: "",
      }),
    };

    await expect(
      new NodeCommitAndPush(git).push({
        baseBranch: "main",
        headBranch: "feature",
        baseRevision: revision("c"),
        headRevision: revision("b"),
      }),
    ).rejects.toMatchObject({ category: "push", code: "REMOTE_BASE_CHANGED" });
  });
});
