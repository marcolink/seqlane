// @test-scope ./marker-validation.ts
// @test-scope ./git-port.ts

import { describe, expect, it } from "vitest";

import { validateStagedConflictMarkers } from "./marker-validation.js";
import type { GitWorkspacePort } from "./git-port.js";

const revision = "0123456789abcdef0123456789abcdef01234567";

describe("staged marker validation", () => {
  it("reads all staged conflict paths in one batched content query", async () => {
    const commands: readonly string[][] = [];
    const git: GitWorkspacePort = {
      cwd: "/tmp/target",
      run: async (args) => {
        (commands as string[][]).push([...args]);
        if (args[0] === "ls-files") {
          return {
            executable: "git",
            args,
            cwd: "/tmp/target",
            exitCode: 0,
            stdout: [
              `100644 ${revision} 0\tone.ts`,
              `100644 ${revision} 0\ttwo.ts`,
            ].join("\0"),
            stderr: "",
          };
        }
        if (args[0] === "show") {
          return {
            executable: "git",
            args,
            cwd: "/tmp/target",
            exitCode: 0,
            stdout: "<<<<<<< ours\nresolved\n",
            stderr: "",
          };
        }
        return {
          executable: "git",
          args,
          cwd: "/tmp/target",
          exitCode: 0,
          stdout: "",
          stderr: "",
        };
      },
    };

    await expect(
      validateStagedConflictMarkers("/tmp/target", ["one.ts", "two.ts"], git),
    ).rejects.toMatchObject({ code: "CONFLICT_MARKER_REMAINS" });
    expect(commands.filter(([command]) => command === "show")).toHaveLength(1);
  });
});
