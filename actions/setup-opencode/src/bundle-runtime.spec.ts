// @test-scope ./main.ts

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("setup-opencode action bundle", () => {
  it("imports the bundled entrypoint without running setup", async () => {
    await expect(
      execFileAsync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          "await import(process.argv[1])",
          new URL("../dist/main.js", import.meta.url).href,
        ],
        { env: { ...process.env, NODE_ENV: "test" } },
      ),
    ).resolves.toBeDefined();
  });
});
