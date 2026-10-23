// @test-scope ./opencode-runtime.ts
// @test-scope ./opencode-process.ts

import { execFile, spawn, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as filesystem from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";

import * as processOwnership from "@seqlane/agent-adapter/private/owned-process";

import {
  NodeOpenCodeRuntime,
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
  type OpenCodeRuntimeOptions,
} from "./opencode-runtime.js";

vi.mock("node:crypto", { spy: true });
vi.mock("node:fs/promises", { spy: true });

describe("resolver OpenCode runtime", () => {
  it("keeps the pinned model, version, policy, and loopback binding", () => {
    const config = buildOpenCodeConfig("/trusted/resolver-skills");

    expect(config).toContain('"model":"openai/gpt-6.1-sol"');
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

  it.each([
    {
      reason: "a non-OK status",
      status: 503,
      headers: {},
      error: "Archive download failed: 503",
    },
    {
      reason: "an oversized content length",
      status: 200,
      headers: { "content-length": String(OPENCODE_ARCHIVE_MAX_BYTES + 1) },
      error: "The OpenCode archive exceeds the maximum download size.",
    },
  ])(
    "closes the HTTP socket after $reason",
    async ({ status, headers, error }) => {
      let connectionClosed = false;
      const server = createServer((request, response) => {
        request.socket.once("close", () => {
          connectionClosed = true;
        });
        response.writeHead(status, headers);
        response.write("a response that remains open");
      });
      await new Promise<void>((resolveListen) =>
        server.listen(0, "127.0.0.1", resolveListen),
      );
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("Missing archive fixture address.");
      try {
        await expect(
          downloadOpenCodeArchive(`http://127.0.0.1:${address.port}/archive`),
        ).rejects.toThrow(error);
        await expect
          .poll(() => connectionClosed, { timeout: 1_000 })
          .toBe(true);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolveClose) =>
          server.close(() => resolveClose()),
        );
      }
    },
  );
});

describe("OpenCode parent workspace ownership", () => {
  it("marks startup cleanup uncertainty before rejecting with its original null cause", async () => {
    const fixture = await runtimeFixture();
    const events: string[] = [];
    const onUncertain = vi.fn(() => events.push("unsafe"));
    const startupFailure = new Error("health fixture failed");
    try {
      const failure = await fixture
        .runtime({
          onUncertain,
          healthcheck: async () => {
            vi.spyOn(
              processOwnership,
              "terminateOwnedProcess",
            ).mockRejectedValueOnce(null);
            throw startupFailure;
          },
        })
        .start(fixture.directory)
        .catch((cause: unknown) => {
          events.push("failed");
          return cause;
        });
      expect(events).toEqual(["unsafe", "failed"]);
      expect(onUncertain).toHaveBeenCalledExactlyOnceWith(null);
      expect(failure).toMatchObject({
        cause: { errors: [startupFailure, null] },
      });
      expect(
        await filesystem.readFile(
          join(fixture.installation, "opencode"),
          "utf8",
        ),
      ).toBe("fixture executable");
    } finally {
      await fixture.cleanup();
    }
  });

  it("marks stop uncertainty once before rejecting with its original false cause", async () => {
    const fixture = await runtimeFixture();
    const events: string[] = [];
    const onUncertain = vi.fn(() => events.push("unsafe"));
    try {
      const handle = await fixture
        .runtime({ onUncertain })
        .start(fixture.directory);
      vi.spyOn(processOwnership, "terminateOwnedProcess").mockRejectedValueOnce(
        false,
      );
      const failure = await handle.stop().catch((cause: unknown) => {
        events.push("failed");
        return cause;
      });
      expect(events).toEqual(["unsafe", "failed"]);
      expect(failure).toMatchObject({ cause: false });
      await expect(handle.stop()).rejects.toBe(failure);
      expect(onUncertain).toHaveBeenCalledExactlyOnceWith(false);
      expect(
        await filesystem.readFile(
          join(fixture.installation, "opencode"),
          "utf8",
        ),
      ).toBe("fixture executable");
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps the parent safe after a startup failure with confirmed process cleanup", async () => {
    const fixture = await runtimeFixture();
    const onUncertain = vi.fn();
    const startupFailure = new Error("health fixture failed");
    try {
      await expect(
        fixture
          .runtime({
            onUncertain,
            healthcheck: async () => {
              throw startupFailure;
            },
          })
          .start(fixture.directory),
      ).rejects.toMatchObject({ cause: startupFailure });
      expect(onUncertain).not.toHaveBeenCalled();
      expect(fixture.child?.signalCode).toBe("SIGTERM");
      await expect(filesystem.stat(fixture.installation)).rejects.toMatchObject(
        { code: "ENOENT" },
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps the parent safe when file removal fails after confirmed process cleanup", async () => {
    const fixture = await runtimeFixture();
    const onUncertain = vi.fn();
    const removalFailure = new Error("file fixture failed");
    try {
      const handle = await fixture
        .runtime({ onUncertain })
        .start(fixture.directory);
      vi.spyOn(filesystem, "rm").mockRejectedValueOnce(removalFailure);
      await expect(handle.stop()).rejects.toMatchObject({
        cause: removalFailure,
      });
      expect(onUncertain).not.toHaveBeenCalled();
      expect(fixture.child?.signalCode).toBe("SIGTERM");
      expect(
        await filesystem.readFile(
          join(fixture.installation, "opencode"),
          "utf8",
        ),
      ).toBe("fixture executable");
    } finally {
      await fixture.cleanup();
    }
  });
});

const execFileAsync = promisify(execFile);

// Substitute only the production archive pin. Extraction and process ownership stay real.
function fixtureDigest(): Buffer<ArrayBuffer>;
function fixtureDigest(encoding: crypto.BinaryToTextEncoding): string;
function fixtureDigest(
  encoding?: crypto.BinaryToTextEncoding,
): Buffer<ArrayBuffer> | string {
  const digest = Buffer.from(OPENCODE_ARCHIVE_SHA256, "hex");
  return encoding === undefined ? digest : digest.toString(encoding);
}

async function runtimeFixture() {
  const directory = await filesystem.mkdtemp(
    join(tmpdir(), "seqlane-runtime-parent-"),
  );
  const archivePath = join(directory, "archive.tar.gz");
  await filesystem.writeFile(join(directory, "opencode"), "fixture executable");
  await execFileAsync("tar", [
    "-czf",
    archivePath,
    "-C",
    directory,
    "opencode",
  ]);
  const hash = crypto.createHash("sha256");
  hash.digest = fixtureDigest;
  vi.spyOn(crypto, "createHash").mockReturnValueOnce(hash);
  let child: ChildProcess | undefined;
  let installation = "";
  return {
    directory,
    get child() {
      return child;
    },
    get installation() {
      return installation;
    },
    runtime: (options: OpenCodeRuntimeOptions) =>
      new NodeOpenCodeRuntime({
        healthcheck: async () => true,
        ...options,
        temporaryParent: directory,
        skillDirectory: directory,
        download: () => filesystem.readFile(archivePath),
        start: (executable, _args, options) => {
          installation = dirname(executable);
          child = spawn(
            process.execPath,
            ["-e", "setInterval(() => {}, 1000)"],
            { ...options, stdio: "ignore" },
          );
          return child;
        },
      }),
    cleanup: async () => {
      vi.restoreAllMocks();
      if (
        child !== undefined &&
        child.exitCode === null &&
        child.signalCode === null
      ) {
        const closed = new Promise<void>((resolveClose) =>
          child?.once("close", () => resolveClose()),
        );
        child.kill("SIGKILL");
        await closed;
      }
      await filesystem.rm(directory, { recursive: true, force: true });
    },
  };
}
