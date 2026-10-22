// @test-scope ./opencode-process.ts

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { Effect, Exit, Scope } from "effect";
import { describe, expect, it, vi } from "vitest";

import * as processOwnership from "@seqlane/agent-adapter/private/owned-process";

import {
  startOpenCodeProcess,
  type OpenCodeProcessState,
} from "./opencode-process.js";

function observeSpawn(observe: (child: ChildProcess) => void) {
  return (
    executable: string,
    args: readonly string[],
    options: {
      readonly cwd: string;
      readonly env: Readonly<Record<string, string>>;
      readonly detached: boolean;
    },
  ) => {
    const child = spawn(executable, args, { ...options, stdio: "ignore" });
    observe(child);
    return child;
  };
}

describe("OpenCode process lifecycle", () => {
  it("cancels a successful health response body before declaring readiness", async () => {
    const closedResponse = deferred<void>();
    const server = createServer((_request, response) => {
      response.writeHead(200);
      response.write("a response that remains open");
      response.once("close", () => closedResponse.resolve());
    });
    await new Promise<void>((resolveListen) =>
      server.listen(0, "127.0.0.1", resolveListen),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Missing health fixture address.");
    const state: OpenCodeProcessState = { safeToDelete: true };
    try {
      await Effect.runPromise(
        Effect.scoped(
          startOpenCodeProcess(
            process.execPath,
            process.cwd(),
            ["-e", "setInterval(() => {}, 1000)"],
            { PATH: process.env.PATH ?? "" },
            `http://127.0.0.1:${address.port}/global/health`,
            {},
            state,
          ),
        ),
      );
      await Effect.runPromise(
        Effect.tryPromise(() => closedResponse.promise).pipe(
          Effect.timeout("1 second"),
        ),
      );
      expect(state.safeToDelete).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolveClose) =>
        server.close(() => resolveClose()),
      );
    }
  });

  it("aborts a real health request at the native readiness deadline", async () => {
    const reachedHealthcheck = deferred<void>();
    const requestClosed = deferred<void>();
    const server = createServer((request) => {
      reachedHealthcheck.resolve();
      request.once("close", () => requestClosed.resolve());
    });
    await new Promise<void>((resolveListen) =>
      server.listen(0, "127.0.0.1", resolveListen),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Missing health fixture address.");
    const state: OpenCodeProcessState = { safeToDelete: true };
    try {
      const running = Effect.runPromise(
        Effect.scoped(
          startOpenCodeProcess(
            process.execPath,
            process.cwd(),
            ["-e", "setInterval(() => {}, 1000)"],
            { PATH: process.env.PATH ?? "" },
            `http://127.0.0.1:${address.port}/global/health`,
            { readinessTimeoutMs: 200, pollIntervalMs: 10 },
            state,
          ),
        ),
      );
      await reachedHealthcheck.promise;
      await expect(running).rejects.toThrow("did not become ready");
      await Effect.runPromise(
        Effect.tryPromise(() => requestClosed.promise).pipe(
          Effect.timeout("1 second"),
        ),
      );
      expect(state.safeToDelete).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolveClose) =>
        server.close(() => resolveClose()),
      );
    }
  });

  it("stops and joins its known child when birth identity capture fails", async () => {
    const capture = vi
      .spyOn(processOwnership, "captureOwnedProcessIdentity")
      .mockRejectedValueOnce(new Error("identity inspection failed"));
    const state: OpenCodeProcessState = { safeToDelete: true };
    let child: ChildProcess | undefined;
    try {
      await expect(
        Effect.runPromise(
          Effect.scoped(
            startOpenCodeProcess(
              process.execPath,
              process.cwd(),
              ["-e", "setInterval(() => {}, 1000)"],
              { PATH: process.env.PATH ?? "" },
              "http://127.0.0.1:4096/global/health",
              {
                start: observeSpawn((acquired) => {
                  child = acquired;
                }),
              },
              state,
            ),
          ),
        ),
      ).rejects.toThrow("identity inspection failed");
      expect(state.safeToDelete).toBe(true);
      expect(child?.signalCode).toBe("SIGTERM");
      const processId = child?.pid;
      expect(processId).toBeDefined();
      if (processId !== undefined)
        expect(() => process.kill(processId, 0)).toThrow();
    } finally {
      capture.mockRestore();
      if (child?.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }
  });

  it("cancels startup and closes its acquired process scope", async () => {
    const scope = Effect.runSync(Scope.make());
    const controller = new AbortController();
    const reachedHealthcheck = deferred<void>();
    const state: OpenCodeProcessState = { safeToDelete: true };
    let pid: number | undefined;
    const running = Effect.runPromise(
      Effect.provideService(
        startOpenCodeProcess(
          process.execPath,
          process.cwd(),
          ["-e", "setInterval(() => {}, 1000)"],
          { PATH: process.env.PATH ?? "" },
          "http://127.0.0.1:4096/global/health",
          {
            start: observeSpawn((child) => {
              pid = child.pid;
            }),
            healthcheck: async (_url, signal) => {
              reachedHealthcheck.resolve();
              await new Promise<void>((_resolve, reject) => {
                signal?.addEventListener("abort", () => reject(signal.reason), {
                  once: true,
                });
              });
              return false;
            },
            pollIntervalMs: 10,
          },
          state,
        ),
        Scope.Scope,
        scope,
      ),
      { signal: controller.signal },
    );
    await reachedHealthcheck.promise;
    controller.abort(new Error("cancel startup"));
    await expect(running).rejects.toBeDefined();
    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(state.safeToDelete).toBe(true);
    expect(pid).toBeDefined();
    if (pid !== undefined) expect(() => process.kill(pid!, 0)).toThrow();
  });

  it("kills an owned SIGTERM-resistant child and preserves a foreign process", async () => {
    const scope = Effect.runSync(Scope.make());
    const state: OpenCodeProcessState = { safeToDelete: true };
    const healthServer = createServer((_request, response) => {
      response.writeHead(200);
      response.end("ok");
    });
    healthServer.listen(0, "127.0.0.1");
    await new Promise<void>((resolveListen, rejectListen) => {
      healthServer.once("listening", resolveListen);
      healthServer.once("error", rejectListen);
    });
    const address = healthServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("Loopback health fixture has no TCP address.");
    }
    let ownedPid: number | undefined;
    await Effect.runPromise(
      Effect.provideService(
        startOpenCodeProcess(
          process.execPath,
          process.cwd(),
          [
            "-e",
            "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
          ],
          { PATH: process.env.PATH ?? "" },
          `http://127.0.0.1:${address.port}/global/health`,
          {
            start: observeSpawn((child) => {
              ownedPid = child.pid;
            }),
          },
          state,
        ),
        Scope.Scope,
        scope,
      ),
    );
    const foreign = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        cwd: process.cwd(),
        stdio: "ignore",
      },
    );
    try {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      expect(state.safeToDelete).toBe(true);
      expect(ownedPid).toBeDefined();
      if (ownedPid !== undefined)
        expect(() => process.kill(ownedPid!, 0)).toThrow();
      expect(foreign.pid).toBeDefined();
      expect(() => process.kill(foreign.pid!, 0)).not.toThrow();
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        healthServer.close((error) =>
          error === undefined ? resolveClose() : rejectClose(error),
        );
      });
      if (foreign.exitCode === null) {
        const exited = new Promise<void>((resolveExit) => {
          foreign.once("exit", () => resolveExit());
        });
        foreign.kill("SIGKILL");
        await exited;
      }
    }
  });
});

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
