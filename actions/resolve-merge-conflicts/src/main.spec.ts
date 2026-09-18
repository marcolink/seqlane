import { existsSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { resolverSkillDirectory } from "./main.js";

const originalActionPath = process.env.GITHUB_ACTION_PATH;

afterEach(() => {
  if (originalActionPath === undefined) {
    delete process.env.GITHUB_ACTION_PATH;
  } else {
    process.env.GITHUB_ACTION_PATH = originalActionPath;
  }
});

describe("resolve merge conflicts Action assets", () => {
  it("resolves the shipped skill directory without GITHUB_ACTION_PATH", () => {
    delete process.env.GITHUB_ACTION_PATH;

    const skillDirectory = resolverSkillDirectory();

    expect(basename(skillDirectory)).toBe("skills");
    expect(skillDirectory).toBe(
      fileURLToPath(new URL("../skills", import.meta.url)),
    );
    expect(existsSync(skillDirectory)).toBe(true);
  });
});
