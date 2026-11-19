// @test-scope ./main.ts
// @test-scope ./post.ts

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("OpenCode action bundle", () => {
  it("redacts server stderr and reports its log path when startup fails", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "opencode-startup-failure-"),
    );
    const output = join(directory, "output");
    const state = join(directory, "state");
    await Promise.all([
      writeFile(output, ""),
      writeFile(state, ""),
      writeFile(
        join(directory, "serve"),
        "process.stderr.write(`startup failed key=${process.env.OPENAI_API_KEY} token=${process.env.REVIEW_TOKEN}\\n`); process.exit(1);",
      ),
    ]);
    try {
      await expect(
        execFileAsync(
          process.execPath,
          [fileURLToPath(new URL("../dist/main.js", import.meta.url))],
          {
            env: {
              ...process.env,
              NODE_ENV: "production",
              RUNNER_TEMP: directory,
              GITHUB_OUTPUT: output,
              GITHUB_STATE: state,
              OPENAI_API_KEY: "test-openai-credential",
              REVIEW_TOKEN: "test-review-credential",
              SEQLANE_REDACT_VALUES: "test-review-credential",
              "INPUT_WORKING-DIRECTORY": directory,
              INPUT_EXECUTABLE: process.execPath,
              INPUT_HOSTNAME: "127.0.0.1",
              INPUT_PORT: "1",
              "INPUT_STARTUP-TIMEOUT-SECONDS": "1",
            },
          },
        ),
      ).rejects.toMatchObject({
        code: 1,
        stdout: expect.stringContaining(
          "startup failed key=[REDACTED] token=[REDACTED]",
        ),
      });
      expect(await readFile(output, "utf8")).toContain(
        join(directory, "opencode.log"),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

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
          fileURLToPath(new URL("../dist/process-anchor.js", import.meta.url)),
        ],
        { env },
      ),
    ).resolves.toBeDefined();
  });
});
