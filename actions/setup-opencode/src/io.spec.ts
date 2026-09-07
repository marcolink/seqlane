// @test-scope ./io.ts

import { describe, expect, it, vi } from "vitest";
import {
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
});
