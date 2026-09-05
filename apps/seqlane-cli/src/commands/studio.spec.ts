// @test-scope ./studio.ts

import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  communityStudioExitCode,
  launchCommunityStudio,
  waitForCommunityStudio,
} from "./studio.js";

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

  it("reports the local UI over HTTP when the server uses HTTPS", () => {
    const result = launchCommunityStudio({ serverProtocol: "https" });

    expect(result.address).toBe("http://127.0.0.1:3000");
  });

  it("propagates child failures and signals as process exit codes", () => {
    expect(communityStudioExitCode({ code: 7, signal: null })).toBe(7);
    expect(communityStudioExitCode({ code: null, signal: "SIGINT" })).toBe(130);
    expect(communityStudioExitCode({ code: null, signal: "SIGTERM" })).toBe(
      143,
    );
  });

  it("forwards termination signals and removes handlers after the child exits", async () => {
    const child = new EventEmitter() as EventEmitter & {
      kill: ReturnType<typeof vi.fn>;
    };
    child.kill = vi.fn();
    const signals = new EventEmitter();

    const exit = waitForCommunityStudio(
      child as unknown as ChildProcess,
      signals,
    );
    signals.emit("SIGTERM");
    signals.emit("SIGTERM");
    child.emit("exit", null, "SIGTERM");

    await expect(exit).resolves.toEqual({ code: null, signal: "SIGTERM" });
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
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
