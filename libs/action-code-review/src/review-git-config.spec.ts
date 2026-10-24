import { describe, expect, it } from "vitest";
import {
  reviewGitOptionsSchema,
  reviewGitEnvironment,
} from "./review-git-config.js";

describe("native Git configuration", () => {
  it("rejects remote options and invalid checkout paths", () => {
    for (const options of [
      {
        reviewTarget: "/repo",
        trustedRemote: { url: "https://example.test/repo.git" },
      },
      { reviewTarget: "relative" },
      { reviewTarget: "/repo\0path" },
    ]) {
      expect(reviewGitOptionsSchema.safeParse(options).success).toBe(false);
    }
  });
  it("constructs a clean environment without inherited credentials or Git config", () => {
    const env = reviewGitEnvironment();
    expect(env).toMatchObject({
      HOME: "/dev/null",
      GIT_NO_LAZY_FETCH: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    });
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
    expect(env).not.toHaveProperty("GIT_CONFIG_PARAMETERS");
  });
});
