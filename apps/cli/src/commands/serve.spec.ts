// @test-scope ../operational-workflows.ts
// @test-scope ../workflow-discovery.ts

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { loadOperationalWorkflows } from "../operational-workflows.js";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));

describe("serve workflow loading", () => {
  it("loads and compiles every discovered workflow before host startup", async () => {
    const directory = mkdtempSync(join(tmpdir(), "seqlane-serve-"));
    const repository = join(directory, "repository");
    const user = join(directory, "user");
    mkdirSync(repository);
    mkdirSync(user);
    try {
      writeFileSync(
        join(repository, "local-only.json"),
        JSON.stringify({
          name: "local-only",
          moduleSpecifier: pathToFileURL(
            join(repositoryRoot, "examples/local-only.ts"),
          ).href,
          exportName: "default",
          description: "Local-only fixture",
        }),
      );

      const workflows = await loadOperationalWorkflows({ repository, user });

      expect(workflows).toHaveLength(1);
      expect(workflows[0]?.key).toBe("repository:local-only");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
