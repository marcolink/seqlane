// @test-scope ./entrypoint.ts

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("setup-opencode action bundle", () => {
  it("invokes the bundled entrypoint in test mode", async () => {
    await expect(
      execFileAsync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          "await import(process.argv[1])",
          new URL("../dist/main.js", import.meta.url).href,
        ],
        {
          env: {
            ...process.env,
            NODE_ENV: "test",
            INPUT_VERSION: "",
          },
        },
      ),
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining(
        "Input required and not supplied: version",
      ),
    });
  });
});
