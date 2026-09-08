// @test-scope ./main.ts
// @test-scope ./post.ts

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("Ripwire action bundle", () => {
  it.each(["main.js", "post.js"])(
    "loads %s as ESM without starting the service",
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
          { env: { ...process.env, NODE_ENV: "test" } },
        ),
      ).resolves.toBeDefined();
    },
  );

  it("ships the process anchor beside the action", () => {
    expect(existsSync(new URL("../process-anchor.js", import.meta.url))).toBe(
      true,
    );
  });

  it("does not let NODE_ENV disable the directly executed main bundle", async () => {
    const main = new URL("../dist/main.js", import.meta.url);
    await expect(
      execFileAsync(process.execPath, [main.pathname], {
        env: { ...process.env, NODE_ENV: "test" },
      }),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining("working-directory"),
    });
  });
});
