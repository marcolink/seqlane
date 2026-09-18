// @test-scope ./opencode-runtime.ts

import { describe, expect, it } from "vitest";

import {
  OPENCODE_ARCHIVE_MAX_BYTES,
  OPENCODE_DOWNLOAD_TIMEOUT_MS,
  OPENCODE_ARCHIVE_SHA256,
  OPENCODE_HOST,
  OPENCODE_PORT,
  OPENCODE_SKILL_NAME,
  OPENCODE_VERSION,
  buildOpenCodeConfig,
  buildOpenCodeChildEnvironment,
  downloadOpenCodeArchive,
  resolveOpenCodeSkillDirectory,
  verifyOpenCodeArchive,
  waitForOpenCodeReady,
} from "./opencode-runtime.js";

describe("resolver OpenCode runtime", () => {
  it("keeps the pinned version, policy, and loopback binding", () => {
    const config = buildOpenCodeConfig("/trusted/resolver-skills");

    expect(OPENCODE_VERSION).toBe("1.18.27");
    expect(OPENCODE_ARCHIVE_SHA256).toBe(
      "4af5494f9433f59db8c1e344198f0ee72a50c06ec009fb4a8aeab4c2d4abd702",
    );
    expect(OPENCODE_HOST).toBe("127.0.0.1");
    expect(OPENCODE_PORT).toBe(4096);
    expect(config).toContain('"bash":"deny"');
    expect(config).toContain('"external_directory":"deny"');
  });

  it("exposes only the resolver-owned Git skill", () => {
    const skillDirectory = "/trusted/actions/resolve-merge-conflicts/skills";
    const config = JSON.parse(buildOpenCodeConfig(skillDirectory));
    const environment = buildOpenCodeChildEnvironment(
      { PATH: "/usr/bin" },
      skillDirectory,
    );

    expect(config.skills.paths).toEqual([skillDirectory]);
    expect(config.permission.skill).toEqual({
      "*": "deny",
      [OPENCODE_SKILL_NAME]: "allow",
    });
    expect(environment.OPENCODE_DISABLE_EXTERNAL_SKILLS).toBe("true");
    expect(environment.OPENCODE_CONFIG_CONTENT).toBe(
      buildOpenCodeConfig(skillDirectory),
    );
    expect(
      resolveOpenCodeSkillDirectory("/trusted/actions/resolve-merge-conflicts"),
    ).toBe(skillDirectory);
  });

  it("rejects an archive before extraction when its hash is wrong", () => {
    expect(() => verifyOpenCodeArchive(new Uint8Array([1, 2, 3]))).toThrow(
      /archive hash/i,
    );
  });

  it("injects only the allowlisted runtime environment into the child", () => {
    const skillDirectory = "/trusted/resolver-skills";
    const environment = buildOpenCodeChildEnvironment(
      {
        PATH: "/usr/bin",
        HOME: "/tmp/home",
        OPENAI_API_KEY: "openai-secret",
        GITHUB_TOKEN: "github-secret",
        GH_TOKEN: "gh-secret",
        "INPUT_PUSH-TOKEN": "push-secret",
      },
      skillDirectory,
    );

    expect(environment).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/tmp/home",
      OPENAI_API_KEY: "openai-secret",
      OPENCODE_CONFIG_CONTENT: buildOpenCodeConfig(skillDirectory),
    });
    expect(environment).not.toHaveProperty("GITHUB_TOKEN");
    expect(environment).not.toHaveProperty("GH_TOKEN");
    expect(environment).not.toHaveProperty("INPUT_PUSH-TOKEN");
  });

  it("bounds archive response size and applies a download timeout", async () => {
    const originalFetch = globalThis.fetch;
    let signal: AbortSignal | undefined;
    globalThis.fetch = (async (_input, init) => {
      signal = init?.signal ?? undefined;
      return new Response("small", {
        headers: {
          "content-length": String(OPENCODE_ARCHIVE_MAX_BYTES + 1),
        },
      });
    }) as typeof fetch;
    try {
      await expect(
        downloadOpenCodeArchive("https://example.test/archive"),
      ).rejects.toThrow(/maximum download size/i);
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(OPENCODE_DOWNLOAD_TIMEOUT_MS).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fails immediately when the OpenCode child exits before readiness", async () => {
    const child = { exitCode: 1 };
    let healthChecks = 0;
    await expect(
      waitForOpenCodeReady(
        child,
        async () => {
          healthChecks += 1;
          return false;
        },
        60_000,
        60_000,
      ),
    ).rejects.toMatchObject({ code: "AGENT_FAILED" });
    expect(healthChecks).toBe(0);
  });

  it("fails immediately when the OpenCode child reports a startup error", async () => {
    let healthChecks = 0;
    await expect(
      waitForOpenCodeReady(
        { exitCode: null },
        async () => {
          healthChecks += 1;
          return false;
        },
        60_000,
        60_000,
        () => new Error("spawn failed"),
      ),
    ).rejects.toMatchObject({ code: "AGENT_FAILED" });
    expect(healthChecks).toBe(0);
  });
});
