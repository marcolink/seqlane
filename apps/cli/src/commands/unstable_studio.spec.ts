// @test-scope ./unstable_studio.ts

import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StudioCommand from "./unstable_studio.js";
import { startOwnedOperationalHost } from "../operational-command-host.js";
import {
  communityStudioExitCode,
  createOwnedHostSignalLifecycle,
  launchCommunityStudio,
  resolveStudioServerOptions,
  waitForOperationalHostReady,
  waitForCommunityStudio,
} from "./unstable_studio.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));
vi.mock("../operational-command-host.js", () => ({
  startOwnedOperationalHost: vi.fn(),
}));

describe("Community Studio launcher", () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReturnValue({} as ChildProcess);
    vi.mocked(startOwnedOperationalHost).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts the pinned Mastra CLI Studio with the configured server", () => {
    const result = launchCommunityStudio({
      port: 3001,
      serverHost: "127.0.0.1",
      serverPort: 4112,
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
      ],
      { stdio: "inherit" },
    );
  });

  it("does not expose unsupported protocol or API-prefix flags", () => {
    expect(StudioCommand.flags).not.toHaveProperty("server-protocol");
    expect(StudioCommand.flags).not.toHaveProperty("server-api-prefix");
  });

  it("resolves an attach URL without granting host ownership", () => {
    expect(resolveStudioServerOptions("http://localhost:4112")).toEqual({
      serverHost: "localhost",
      serverPort: 4112,
      origin: "http://localhost:4112",
    });
  });

  it.each([
    "https://127.0.0.1:4111",
    "http://example.test:4111",
    "http://127.0.0.1:4111/api",
  ])("rejects non-loopback attach URL %s", (serverUrl) => {
    expect(() => resolveStudioServerOptions(serverUrl)).toThrow(
      /Operational server URL/,
    );
  });

  it("waits through a starting response before declaring the host ready", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await waitForOperationalHostReady(
      "http://127.0.0.1:4111",
      fetchImplementation,
    );

    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(fetchImplementation).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:4111/readyz",
      { signal: expect.any(AbortSignal) },
    );
  });

  it("cancels every readiness response body", async () => {
    const cancel = vi.fn(async () => {
      throw new Error("body cleanup failed");
    });
    const response = {
      ok: true,
      status: 200,
      body: { cancel },
    } as unknown as Response;

    await waitForOperationalHostReady(
      "http://127.0.0.1:4111",
      vi.fn<typeof fetch>().mockResolvedValue(response),
    );

    expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds a hanging readiness probe by the overall deadline", async () => {
    vi.useFakeTimers();
    try {
      const fetchImplementation = vi.fn<typeof fetch>(
        (_input, init) =>
          new Promise((_, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(init.signal?.reason),
            );
          }),
      );
      const readiness = waitForOperationalHostReady(
        "http://127.0.0.1:4111",
        fetchImplementation,
        100,
      );
      const rejection = expect(readiness).rejects.toThrow(
        "Operational host did not become ready",
      );

      await vi.advanceTimersByTimeAsync(100);

      await rejection;
      expect(fetchImplementation).toHaveBeenCalledOnce();
      expect(fetchImplementation.mock.calls[0]?.[1]?.signal?.aborted).toBe(
        true,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("parses the server port flag and owns the configured operational host", async () => {
    const child = new EventEmitter() as EventEmitter & {
      kill: ReturnType<typeof vi.fn>;
    };
    child.kill = vi.fn();
    const close = vi.fn(async () => undefined);
    vi.mocked(startOwnedOperationalHost).mockResolvedValue({
      address: "http://localhost:42123",
      close,
    } as never);
    vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    setTimeout(() => child.emit("exit", 0, null), 250);

    await StudioCommand.run([
      "--server-host",
      "localhost",
      "--server-port",
      "0",
    ]);

    expect(startOwnedOperationalHost).toHaveBeenCalledOnce();
    expect(startOwnedOperationalHost).toHaveBeenCalledWith(
      expect.objectContaining({ host: "localhost", port: 0 }),
    );
    expect(spawn).toHaveBeenCalledWith(
      expect.stringMatching(/node|mastra/),
      expect.arrayContaining([
        "--server-host",
        "localhost",
        "--server-port",
        "42123",
      ]),
      { stdio: "inherit" },
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it("attaches without owning or stopping an external host", async () => {
    const child = new EventEmitter() as EventEmitter & {
      kill: ReturnType<typeof vi.fn>;
    };
    child.kill = vi.fn();
    vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    setTimeout(() => child.emit("exit", 0, null), 250);

    await StudioCommand.run(["--server-url", "http://127.0.0.1:4112"]);

    expect(startOwnedOperationalHost).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("closes an owned host when Community Studio fails", async () => {
    const child = new EventEmitter() as EventEmitter & {
      kill: ReturnType<typeof vi.fn>;
    };
    child.kill = vi.fn();
    const close = vi.fn(async () => undefined);
    vi.mocked(startOwnedOperationalHost).mockResolvedValue({
      address: "http://127.0.0.1:4111",
      close,
    } as never);
    vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    setTimeout(() => child.emit("error", new Error("studio failed")), 250);

    await expect(StudioCommand.run([])).rejects.toThrow("studio failed");
    expect(close).toHaveBeenCalledOnce();
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

  it("stops an owned host when shutdown happens before host startup completes", async () => {
    const signals = new EventEmitter();
    const close = vi.fn(async () => undefined);
    const lifecycle = createOwnedHostSignalLifecycle(signals);
    const host = { close } as never;

    signals.emit("SIGTERM");
    lifecycle.setOwnedHost(host);
    await lifecycle.closeOwnedHost();

    expect(close).toHaveBeenCalledOnce();
    expect(lifecycle.isShuttingDown()).toBe(true);
    lifecycle.cleanup();
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("does not launch Studio when shutdown happens during owned host startup", async () => {
    const close = vi.fn(async () => undefined);
    let resolveHost!: (host: unknown) => void;
    vi.mocked(startOwnedOperationalHost).mockReturnValue(
      new Promise((resolve) => {
        resolveHost = resolve;
      }) as never,
    );
    vi.mocked(spawn).mockClear();
    const once = vi.spyOn(process, "once");
    const removeListener = vi.spyOn(process, "removeListener");

    try {
      const run = StudioCommand.run([]);
      await vi.waitFor(() => {
        expect(startOwnedOperationalHost).toHaveBeenCalledOnce();
      });
      const signalCall = once.mock.calls.find(
        ([signal]) => signal === "SIGTERM",
      );
      expect(signalCall).toBeDefined();
      (signalCall?.[1] as () => void)();
      resolveHost({ address: "http://127.0.0.1:4111", close });

      await run;

      expect(spawn).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
      expect(removeListener).toHaveBeenCalledWith("SIGTERM", signalCall?.[1]);
    } finally {
      once.mockRestore();
      removeListener.mockRestore();
    }
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
