// @test-scope ./generated-file-handler.ts
// @test-scope ./generated-file-policy.ts
// @test-scope ./workspace-boundary.ts

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import type { GitWorkspacePort } from "./git-port.js";
import { NodeGeneratedFileHandler } from "./generated-file-handler.js";

describe("generated-file handler", () => {
  it("executes setup and command arrays in the isolated Docker adapter", async () => {
    const target = join(
      tmpdir(),
      `seqlane-generated-handler-${Date.now()}-${Math.random()}`,
    );
    await mkdir(target);
    let snapshot = false;
    const dockerCalls: string[][] = [];
    const dockerEnvironments: Readonly<Record<string, string | undefined>>[] =
      [];
    const git: GitWorkspacePort = {
      cwd: target,
      run: async (args) => {
        if (args[0] === "diff") {
          return {
            executable: "git",
            args,
            cwd: target,
            exitCode: 0,
            stdout: snapshot ? "actions/example/dist/main.js\0" : "",
            stderr: "",
          };
        }
        return {
          executable: "git",
          args,
          cwd: target,
          exitCode: 0,
          stdout: "",
          stderr: "",
        };
      },
    };
    try {
      const handler = new NodeGeneratedFileHandler({
        targetRoot: target,
        git,
        env: { GITHUB_TOKEN: "secret", PATH: "/safe/bin" },
        docker: {
          run: async (request) => {
            dockerCalls.push([...request.args]);
            dockerEnvironments.push(request.env);
            snapshot = true;
            const mount = request.args.find((arg) =>
              arg.endsWith(",target=/workspace"),
            );
            const workspace = mount?.match(/source=(.*),target=/)?.[1];
            if (workspace === undefined) throw new Error("missing workspace");
            await mkdir(join(workspace, "actions/example/dist"), {
              recursive: true,
            });
            await writeFile(
              join(workspace, "actions/example/dist/main.js"),
              "generated\n",
            );
            return { exitCode: 0 };
          },
        },
      });
      await expect(
        handler.run(
          {
            match: "actions/*/dist/*.js",
            outputs: ["actions/*/dist/*.js"],
            handler: {
              setup: [["pnpm", "install", "--ignore-scripts"]],
              command: ["pnpm", "build"],
            },
          },
          [{ path: "actions/example/dist/main.js", stage: 2 }],
        ),
      ).resolves.toEqual(["actions/example/dist/main.js"]);
      expect(dockerCalls).toHaveLength(2);
      expect(dockerCalls[0]).toContain("--network");
      expect(dockerCalls[0]).toContain("bridge");
      expect(dockerCalls[1]).toContain("--network");
      expect(dockerCalls[1]).toContain("none");
      expect(dockerCalls[0]!.slice(-3)).toEqual([
        "pnpm",
        "install",
        "--ignore-scripts",
      ]);
      expect(dockerCalls[1]!.slice(-2)).toEqual(["pnpm", "build"]);
      expect(dockerEnvironments[0]).toEqual({ PATH: "/safe/bin" });
      expect(
        dockerCalls.map((args) =>
          args.find((arg) => arg.endsWith(",target=/tmp/seqlane-corepack")),
        ),
      ).toHaveLength(2);
      expect(
        new Set(
          dockerCalls.map((args) =>
            args.find((arg) => arg.endsWith(",target=/tmp/seqlane-corepack")),
          ),
        ),
      ).toHaveLength(1);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("fails when a handler changes a path outside its output globs", async () => {
    const target = join(
      tmpdir(),
      `seqlane-generated-handler-${Date.now()}-${Math.random()}`,
    );
    await mkdir(target);
    let snapshot = false;
    const git: GitWorkspacePort = {
      cwd: target,
      run: async (args) => ({
        executable: "git",
        args,
        cwd: target,
        exitCode: 0,
        stdout: args[0] === "diff" && snapshot ? "unexpected.txt\0" : "",
        stderr: "",
      }),
    };
    try {
      await expect(
        new NodeGeneratedFileHandler({
          targetRoot: target,
          git,
          docker: {
            run: async (request) => {
              snapshot = true;
              const mount = request.args.find((arg) =>
                arg.endsWith(",target=/workspace"),
              );
              const workspace = mount?.match(/source=(.*),target=/)?.[1];
              if (workspace === undefined) throw new Error("missing workspace");
              await mkdir(join(workspace, "actions/example/dist"), {
                recursive: true,
              });
              await writeFile(
                join(workspace, "actions/example/dist/main.js"),
                "generated\n",
              );
              await writeFile(
                join(workspace, "unexpected.txt"),
                "unexpected\n",
              );
              return { exitCode: 0 };
            },
          },
        }).run(
          {
            match: "actions/*/dist/*.js",
            outputs: ["actions/*/dist/*.js"],
            handler: { command: ["pnpm", "build"] },
          },
          [{ path: "actions/example/dist/main.js", stage: 2 }],
        ),
      ).rejects.toMatchObject({
        category: "operational",
        code: "CONFLICT_HANDLER_FAILED",
      });
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });
});
