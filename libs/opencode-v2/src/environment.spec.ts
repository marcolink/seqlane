import { describe, expect, it } from "vitest";
import { createServerEnvironment } from "./environment.js";

describe("managed V2 environment", () => {
  it("keeps runtime paths and drops credentials and process hooks by default", () => {
    expect(
      createServerEnvironment({
        PATH: "/usr/bin",
        HOME: "/home/fixture",
        TMPDIR: "/tmp/fixture",
        XDG_CONFIG_HOME: "/config/fixture",
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        GITHUB_TOKEN: "github-secret",
        OPENAI_API_KEY: "provider-secret",
        NODE_OPTIONS: "--import=unrelated-hook",
        OPENCODE_SERVER_PASSWORD: "old-password",
      }),
    ).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/fixture",
      TMPDIR: "/tmp/fixture",
      XDG_CONFIG_HOME: "/config/fixture",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    });
  });
  it("passes only explicitly named credentials and settings from the supplied environment", () => {
    expect(
      createServerEnvironment({
        SEQLANE_OPENCODE_V2_ENV: " OPENAI_API_KEY, HTTPS_PROXY, MISSING ",
        OPENAI_API_KEY: "selected-provider-secret",
        HTTPS_PROXY: "http://localhost:8080",
        ANTHROPIC_API_KEY: "unselected-provider-secret",
        GITHUB_TOKEN: "github-secret",
      }),
    ).toEqual({
      OPENAI_API_KEY: "selected-provider-secret",
      HTTPS_PROXY: "http://localhost:8080",
    });
  });
  it.each([
    "*",
    "OPENAI_API_KEY,",
    "KEY WITH SPACES",
    Array(130).fill("KEY").join(","),
  ])("rejects an invalid or unbounded environment selection", (selection) => {
    expect(() =>
      createServerEnvironment({ SEQLANE_OPENCODE_V2_ENV: selection }),
    ).toThrow("managed server environment is invalid");
  });
});
