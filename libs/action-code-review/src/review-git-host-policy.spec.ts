import { describe, expect, it } from "vitest";
import {
  requireLocalReviewGit,
  reviewGitHostOptionsSchema,
  reviewGitEnvironment,
} from "./review-git-host-policy.js";

describe("bounded Git host policy", () => {
  it("permits literal collector commands and hostile paths after the separator", () => {
    expect(() =>
      requireLocalReviewGit([
        "--no-replace-objects",
        "-c",
        "core.quotePath=true",
        "--literal-pathspecs",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--patch",
        `${"a".repeat(40)}...${"b".repeat(40)}`,
        "--",
        ":(glob)*",
        "--output=/tmp/file",
        "line\nfile",
      ]),
    ).not.toThrow();
  });
  it.each([
    ["--no-replace-objects", "fetch", "origin"],
    ["--no-replace-objects", "-c", "alias.foo=!echo unsafe", "foo"],
    ["--no-replace-objects", "diff", "--ext-diff", "--no-textconv", "--"],
    [
      "--no-replace-objects",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--output=/tmp/unsafe",
      "--",
    ],
    ["--no-replace-objects", "cat-file", "-t", "HEAD"],
  ])("rejects commands outside the collector contract: %j", (...argv) => {
    expect(() => requireLocalReviewGit(argv)).toThrowError(/collector/);
  });
  it("rejects target-selected credentials and redirects in trusted remote options", () => {
    for (const url of [
      "http://example.test/repo.git",
      "https://token@example.test/repo.git",
      "https://example.test/repo.git?token=secret",
    ]) {
      expect(
        reviewGitHostOptionsSchema.safeParse({
          reviewTarget: "/repo",
          trustedRemote: { url },
        }).success,
      ).toBe(false);
    }
    expect(
      reviewGitHostOptionsSchema.safeParse({
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
