// @test-scope ./studio.ts

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { launchCommunityStudio } from "./studio.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

describe("Community Studio launcher", () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReturnValue({} as ChildProcess);
  });

  it("starts the pinned Mastra CLI Studio with the configured server", () => {
    const result = launchCommunityStudio({
      port: 3001,
      serverHost: "127.0.0.1",
      serverPort: 4112,
      serverProtocol: "http",
      serverApiPrefix: "/api",
    });

    expect(result.address).toBe("http://127.0.0.1:3001");
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [
        expect.stringContaining("mastra"),
        "studio",
        "--port",
        "3001",
        "--server-host",
        "127.0.0.1",
        "--server-port",
        "4112",
        "--server-protocol",
        "http",
        "--server-api-prefix",
        "/api",
      ],
      { stdio: "inherit" },
    );
  });

  it("uses the pinned Community CLI package", () => {
    const manifest = readFileSync(
      fileURLToPath(
        new URL("../../node_modules/mastra/package.json", import.meta.url),
      ),
      "utf8",
    );

    expect(manifest).toContain('"version": "1.27.3"');
    expect(manifest).toContain('"license": "Apache-2.0"');
  });
});
