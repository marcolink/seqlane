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

  it("passes GitHub authentication through Git config environment variables", async () => {
    const commands: string[][] = [];
    const environments: Array<Readonly<Record<string, string | undefined>>> =
      [];
    const git: GitWorkspacePort = {
      cwd: "/tmp/target",
      run: async (args) => ({
        executable: "git",
        args,
        cwd: "/tmp/target",
        exitCode: 0,
        stdout: "",
        stderr: "",
      }),
      runWithEnvironment: async (args, env) => {
        commands.push([...args]);
        environments.push(env);
        return {
          executable: "git",
          args,
          cwd: "/tmp/target",
          exitCode: 0,
          stdout:
            args[0] === "rev-parse"
              ? args.at(-1)?.endsWith("main")
                ? revision("c")
                : revision("b")
              : "",
          stderr: "",
        };
      },
    };
    const adapter = new NodeCommitAndPush(git, "secret-token");

    await adapter.beforePush();
    await adapter.push({
      baseBranch: "main",
      headBranch: "feature",
      baseRevision: revision("c"),
      headRevision: revision("b"),
    });

    expect(commands.flat()).not.toContain("secret-token");
    expect(environments).toHaveLength(5);
    expect(environments[0]).toMatchObject({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    });
    expect(
      Buffer.from(
        environments[0]?.GIT_CONFIG_VALUE_0?.replace(
          "AUTHORIZATION: basic ",
          "",
        ) ?? "",
        "base64",
      ).toString(),
    ).toContain("secret-token");
  });
});
