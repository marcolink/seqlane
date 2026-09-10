// @test-scope ./main.ts
// @test-scope ./post.ts

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("OpenCode action bundle", () => {
  it.each(["main.js", "post.js"])(
    "imports %s as an ESM action entrypoint without starting the service",
    async (entrypoint) => {
      await expect(
        execFileAsync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            "await import(process.argv[1])",
            new URL(`../dist/${entrypoint}`, import.meta.url).href,
          ],
          {
            env: { ...process.env, NODE_ENV: "test" },
          },
        ),
      ).resolves.toBeDefined();
    },
  );

  it("resolves the shipped process anchor without GITHUB_ACTION_PATH", async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "test" };
    delete env.GITHUB_ACTION_PATH;

    await expect(
      execFileAsync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          "const { processAnchorPath } = await import(process.argv[1]); if (processAnchorPath() !== process.argv[2]) process.exit(1);",
          new URL("../dist/main.js", import.meta.url).href,
          fileURLToPath(new URL("../process-anchor.js", import.meta.url)),
        ],
        { env },
      ),
    ).resolves.toBeDefined();
  });
});
