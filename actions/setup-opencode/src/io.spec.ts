// @test-scope ./io.ts

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createExecutableRunner,
  fetchReleaseMetadata,
  verifyExecutableVersion,
  type FetchLike,
} from "./io.js";

describe("OpenCode I/O adapters", () => {
  it("fetches the exact release URL with only an optional authorization header", async () => {
    const response = {
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ tag_name: "v1.18.27" }),
    } as unknown as Response;
    const fetchImplementation = vi.fn<FetchLike>().mockResolvedValue(response);

    await expect(
      fetchReleaseMetadata("1.18.27", "secret", fetchImplementation),
    ).resolves.toEqual({ tag_name: "v1.18.27" });
    expect(fetchImplementation).toHaveBeenCalledWith(
      "https://api.github.com/repos/anomalyco/opencode/releases/tags/v1.18.27",
      {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "seqlane-setup-opencode-action",
          authorization: "Bearer secret",
        },
      },
    );
  });

  it("uses unauthenticated public release requests when no token is present", async () => {
    const response = {
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({}),
    } as unknown as Response;
    const fetchImplementation = vi.fn<FetchLike>().mockResolvedValue(response);

    await fetchReleaseMetadata("1.18.27", undefined, fetchImplementation);
    expect(fetchImplementation.mock.calls[0]?.[1]).toEqual({
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "seqlane-setup-opencode-action",
      },
    });
  });

  it("fails metadata requests without exposing response bodies", async () => {
    const response = {
      ok: false,
      status: 404,
      json: vi.fn(),
    } as unknown as Response;
    await expect(
      fetchReleaseMetadata(
        "1.18.27",
        undefined,
        vi.fn().mockResolvedValue(response),
      ),
    ).rejects.toThrow("HTTP 404");
  });

  it("runs the executable with separate version arguments", async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: "1.18.27\n" });
    await expect(
      verifyExecutableVersion("/tmp/opencode", "1.18.27", runner),
    ).resolves.toBeUndefined();
    expect(runner).toHaveBeenCalledWith("/tmp/opencode", ["--version"]);
  });

  it("rejects a reported version mismatch", async () => {
    await expect(
      verifyExecutableVersion("/tmp/opencode", "1.18.27", async () => ({
        stdout: "1.18.26\n",
      })),
    ).rejects.toThrow(/expected 1.18.27/);
  });

  it("terminates a non-terminating version check", async () => {
    const root = await mkdtemp(join(tmpdir(), "setup-opencode-test-"));
    const executable = join(root, "opencode");
    await writeFile(
      executable,
      "#!/usr/bin/env node\nsetInterval(() => {}, 1_000);\n",
    );
    await chmod(executable, 0o755);

    try {
      const startedAt = Date.now();
      await expect(
        verifyExecutableVersion(
          executable,
          "1.18.27",
          createExecutableRunner(100),
        ),
      ).rejects.toThrow(/could not report its version/);
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
