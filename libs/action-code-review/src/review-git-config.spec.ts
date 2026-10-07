import { describe, expect, it } from "vitest";
import {
  reviewGitOptionsSchema,
  reviewGitEnvironment,
} from "./review-git-config.js";

describe("native Git configuration", () => {
  it("rejects target-selected credentials and redirects in trusted remote options", () => {
    for (const url of [
      "http://example.test/repo.git",
      "https://token@example.test/repo.git",
      "https://example.test/repo.git?token=secret",
    ]) {
      expect(
        reviewGitOptionsSchema.safeParse({
          reviewTarget: "/repo",
          trustedRemote: { url },
        }).success,
      ).toBe(false);
    }
    expect(
      reviewGitOptionsSchema.safeParse({
        reviewTarget: "relative",
      }).success,
    ).toBe(false);
  });
  it("constructs a clean environment without inherited credentials or Git config", () => {
    const env = reviewGitEnvironment("/empty-home");
    expect(env).toMatchObject({
      HOME: "/empty-home",
      GIT_NO_LAZY_FETCH: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    });
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
    expect(env).not.toHaveProperty("GIT_CONFIG_PARAMETERS");
  });
});
