// @test-scope ./standalone-adapter.ts
import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  createStandaloneAdapterLease,
  StandaloneAdapterSelectionError,
  type StandaloneAdapterService,
} from "./standalone-adapter.js";

function service(
  url = "http://127.0.0.1:4100",
  workspace = "/workspace",
): StandaloneAdapterService<{
  adapter: "opencode";
  url: string;
  workspace: string;
}> {
  return {
    binding: { adapter: "opencode", url, workspace },
    close: vi.fn(async () => undefined),
  };
}

describe("standalone adapter lease", () => {
  it("does not start an adapter before agent demand or after an early close", async () => {
    const startAdapter = vi.fn(async () => service());
    const lease = createStandaloneAdapterLease({
      adapter: "opencode",
      workspace: process.cwd(),
      signal: new AbortController().signal,
      startAdapter,
    });

    await lease.close();

    expect(startAdapter).not.toHaveBeenCalled();
    await expect(lease.acquire()).rejects.toBeInstanceOf(
      StandaloneAdapterSelectionError,
    );
  });

  it("removes its abort listener after an explicit close", async () => {
    const controller = new AbortController();
    const lease = createStandaloneAdapterLease({
      adapter: "opencode",
      workspace: process.cwd(),
      signal: controller.signal,
      startAdapter: async () => service(),
    });

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
    await lease.close();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("starts one shared registry-selected service for concurrent agent demand", async () => {
    const started = service();
    const startAdapter = vi.fn(async () => started);
    const lease = createStandaloneAdapterLease({
      adapter: "opencode",
      workspace: "/workspace",
      signal: new AbortController().signal,
      startAdapter,
    });

    await expect(
      Promise.all([lease.acquire(), lease.acquire()]),
    ).resolves.toEqual([
      { binding: started.binding },
      { binding: started.binding },
    ]);
    expect(startAdapter).toHaveBeenCalledTimes(1);

    await lease.close();
    expect(started.close).toHaveBeenCalledTimes(1);
  });

  it("releases a pending startup when the run closes", async () => {
    let rejectStart: ((cause: unknown) => void) | undefined;
    const startAdapter = vi.fn(
      ({ signal }: { readonly signal: AbortSignal }) =>
        new Promise<
          StandaloneAdapterService<{
            adapter: "opencode";
            url: string;
            workspace: string;
          }>
        >((_resolve, reject) => {
          rejectStart = reject;
          signal.addEventListener(
            "abort",
            () => reject(new Error("startup cancelled")),
            { once: true },
          );
        }),
    );
    const lease = createStandaloneAdapterLease({
      adapter: "opencode",
      workspace: process.cwd(),
      signal: new AbortController().signal,
      startAdapter,
    });
    const acquiring = lease.acquire();

    await lease.close();
    await expect(acquiring).rejects.toThrow("startup cancelled");
    expect(rejectStart).toBeDefined();
  });

  it("does not return a connection when close wins a successful startup race", async () => {
    let resolveStart:
      | ((
          value: StandaloneAdapterService<{
            adapter: "opencode";
            url: string;
            workspace: string;
          }>,
        ) => void)
      | undefined;
    const started = service();
    const lease = createStandaloneAdapterLease({
      adapter: "opencode",
      workspace: process.cwd(),
      signal: new AbortController().signal,
      startAdapter: () =>
        new Promise<
          StandaloneAdapterService<{
            adapter: "opencode";
            url: string;
            workspace: string;
          }>
        >((resolve) => {
          resolveStart = resolve;
        }),
    });
    const acquiring = lease.acquire();
    const closing = lease.close();
    resolveStart?.(started);

    await closing;
    await expect(acquiring).rejects.toBeInstanceOf(
      StandaloneAdapterSelectionError,
    );
    expect(started.close).toHaveBeenCalledTimes(1);
  });

  it("shares one cleanup operation between concurrent close callers", async () => {
    let releaseClose: (() => void) | undefined;
    const started: StandaloneAdapterService<{
      adapter: "opencode";
      url: string;
      workspace: string;
    }> = {
      ...service(),
      close: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseClose = resolve;
          }),
      ),
    };
    const lease = createStandaloneAdapterLease({
      adapter: "opencode",
      workspace: process.cwd(),
      signal: new AbortController().signal,
      startAdapter: async () => started,
    });
    await lease.acquire();
    const first = lease.close();
    const second = lease.close();
    await vi.waitFor(() => expect(started.close).toHaveBeenCalledTimes(1));
    releaseClose?.();

    await Promise.all([first, second]);
    expect(started.close).toHaveBeenCalledTimes(1);
  });

  it("handles an abort cleanup failure while preserving it for the final owner", async () => {
    const controller = new AbortController();
    const started: StandaloneAdapterService<{
      adapter: "opencode";
      url: string;
      workspace: string;
    }> = {
      ...service(),
      close: vi.fn(async () => {
        throw new Error("cleanup failed");
      }),
    };
    const lease = createStandaloneAdapterLease({
      adapter: "opencode",
      workspace: process.cwd(),
      signal: controller.signal,
      startAdapter: async () => started,
    });
    await lease.acquire();

    controller.abort();

    await vi.waitFor(() => expect(started.close).toHaveBeenCalledTimes(1));
    await expect(lease.close()).rejects.toThrow("cleanup failed");
  });

  it("allows an explicit later acquisition after a failed startup", async () => {
    const url = "http://127.0.0.1:4100";
    const started = service(url);
    const startAdapter = vi
      .fn<
        () => Promise<
          StandaloneAdapterService<{
            adapter: "opencode";
            url: string;
            workspace: string;
          }>
        >
      >()
      .mockRejectedValueOnce(new Error("not ready"))
      .mockResolvedValueOnce(started);
    const lease = createStandaloneAdapterLease({
      adapter: "opencode",
      workspace: process.cwd(),
      signal: new AbortController().signal,
      startAdapter,
    });

    await expect(lease.acquire()).rejects.toThrow("not ready");
    const connection = await lease.acquire();
    expect(connection.binding.adapter).toBe("opencode");
    if (connection.binding.adapter === "opencode") {
      expect(connection.binding.url).toBe(url);
    }
    expect(startAdapter).toHaveBeenCalledTimes(2);
  });
});
