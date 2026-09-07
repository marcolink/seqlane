// @test-scope ./main.ts
// @test-scope ./post.ts

import { execFile } from "node:child_process";
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
});
