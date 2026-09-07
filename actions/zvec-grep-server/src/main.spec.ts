import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { packageExecutionDirectory, processAnchorPath } from "./main.js";

const originalActionPath = process.env.GITHUB_ACTION_PATH;

afterEach(() => {
  if (originalActionPath === undefined) {
    delete process.env.GITHUB_ACTION_PATH;
  } else {
    process.env.GITHUB_ACTION_PATH = originalActionPath;
  }
});

describe("zvec-grep action process anchor", () => {
  it("resolves the shipped anchor without GITHUB_ACTION_PATH", () => {
    delete process.env.GITHUB_ACTION_PATH;

    const anchorPath = processAnchorPath();

    expect(basename(anchorPath)).toBe("process-anchor.js");
    expect(anchorPath).toBe(
      fileURLToPath(new URL("../process-anchor.js", import.meta.url)),
    );
    expect(existsSync(anchorPath)).toBe(true);
  });

  it("selects the shipped action directory for package commands", () => {
    process.env.GITHUB_ACTION_PATH = "/untrusted/review-target";

    expect(packageExecutionDirectory()).toBe(dirname(processAnchorPath()));
    expect(packageExecutionDirectory()).not.toBe(process.env.GITHUB_ACTION_PATH);
  });
});
