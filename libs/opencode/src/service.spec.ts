// @test-scope ./service.ts
// @test-scope ./service-process.ts
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as ownership from "@seqlane/agent-adapter/private/owned-process";
import { startOpenCodeService } from "./service.js";
import { OpenCodeServiceStartupError } from "./errors.js";

const controllers: AbortController[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  vi.restoreAllMocks();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = new Promise<void>((resolve) =>
        child.once("exit", () => resolve()),
      );
      child.kill("SIGKILL");
      await exit;
    }
  }
});

function fixture(
  output = "opencode server listening on http://127.0.0.1:4173\n",
  code?: string,
) {
  let command:
    | {
        readonly command: string;
        readonly args: readonly string[];
        readonly options: unknown;
      }
    | undefined;
  let pid: number | undefined;
  const start = vi.fn(
    (
      executable: string,
      args: readonly string[],
      options: import("node:child_process").SpawnOptions,
    ) => {
      command = { command: executable, args, options };
      const child = spawn(
        process.execPath,
        [
          "-e",
          code ??
            `process.stdout.write(${JSON.stringify(output)}); setInterval(() => {}, 1000);`,
        ],
        options,
      );
      children.push(child);
      pid = child.pid;
      return child;
    },
  );
  const controller = new AbortController();
  controllers.push(controller);
  return {
    controller,
    pid: () => pid,
    command: () => command,
    options: {
      workspace: process.cwd(),
      signal: controller.signal,
      spawn: start,
      fetch: vi.fn(async () => new Response(null, { status: 200 })),
      startupTimeoutMs: 2_000,
    },
  };
}

async function assertStopped(pid: number | undefined) {
  if (pid === undefined) throw new Error("Missing fixture PID");
  expect(await ownership.confirmOwnedProcessGroupStopped(pid)).toBe(true);
}

describe("owned OpenCode startup", () => {
  it("registers before health, drains bounded diagnostics, authenticates, and confirms shutdown", async () => {
    const child = fixture();
    let registered = false;
    const service = await startOpenCodeService({
      ...child.options,
      onOwnedProcessAcquired: async (pid) => {
        expect(pid).toBe(child.pid());
        registered = true;
      },
      fetch: vi.fn(async (_url, init) => {
        expect(registered).toBe(true);
        expect(new Headers(init?.headers).get("authorization")).toMatch(
          /^Basic /,
        );
        return new Response(null, { status: 200 });
      }),
    });
    try {
      expect(service.url).toBe("http://127.0.0.1:4173");
      expect(service.authorization).toMatch(/^Basic /);
      expect(service.diagnostics()).toContain("opencode server listening");
      expect(child.command()).toMatchObject({
        command: "opencode",
        args: ["serve", "--hostname=127.0.0.1", "--port=0", "--print-logs"],
        options: {
          cwd: process.cwd(),
          env: {
            OPENCODE_SERVER_USERNAME: "seqlane",
            OPENCODE_SERVER_PASSWORD:
              expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
          },
        },
      });
    } finally {
      await service.close();
    }
    await service.close();
    await assertStopped(child.pid());
  });

  it("recovers from a dropped first request through authenticated native startup", async () => {
    const server = createServer();
    let handlerTimer: ReturnType<typeof setTimeout> | undefined;
    let connections = 0;
    server.on("connection", () => connections++);
    server.once("connection", () => {
      handlerTimer = setTimeout(() => {
        server.on("request", (request, response) => {
          expect(request.url).toBe("/global/health");
          expect(request.headers.authorization).toMatch(/^Basic /);
          response.end("healthy");
        });
      }, 100);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("no test port");
    const child = fixture(
      `opencode server listening on http://127.0.0.1:${address.port}\n`,
    );
    try {
      const service = await startOpenCodeService({
        ...child.options,
        startupTimeoutMs: 5_000,
        fetch: globalThis.fetch,
      });
      try {
        expect(connections).toBeGreaterThanOrEqual(2);
        expect(service.url).toBe(`http://127.0.0.1:${address.port}`);
      } finally {
        await service.close();
      }
      await assertStopped(child.pid());
    } finally {
      clearTimeout(handlerTimer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 10_000);

  it.each([
    ["127.0.0.1", 80, "http://127.0.0.1:80", "http://127.0.0.1"],
    ["::1", 0, "http://[::1]:4173", "http://[::1]:4173"],
  ])(
    "accepts normalized endpoint %s:%s",
    async (host, port, endpoint, expected) => {
      const child = fixture(`opencode server listening on ${endpoint}\n`);
      const service = await startOpenCodeService({
        ...child.options,
        host,
        port,
      });
      try {
        expect(service.url).toBe(expected);
      } finally {
        await service.close();
      }
      await assertStopped(child.pid());
    },
  );

  it("rejects a different requested endpoint and kills the owned group", async () => {
    const child = fixture();
    await expect(
      startOpenCodeService({
        ...child.options,
        port: 4123,
        startupTimeoutMs: 200,
      }),
    ).rejects.toThrow("did not become ready");
    await assertStopped(child.pid());
  });

  it("stops the acquired service when registration fails", async () => {
    const child = fixture();
    const original = Object.freeze(
      new OpenCodeServiceStartupError("registration failed"),
    );
    await expect(
      startOpenCodeService({
        ...child.options,
        onOwnedProcessAcquired: async () => {
          throw original;
        },
      }),
    ).rejects.toBe(original);
    await assertStopped(child.pid());
  });

  it("stops and joins the real tree after cancellation during ownership handoff", async () => {
    const child = fixture();
    const capture = ownership.captureOwnedProcessIdentity;
    vi.spyOn(ownership, "captureOwnedProcessIdentity").mockImplementation(
      async (pid) => {
        child.controller.abort();
        return capture(pid);
      },
    );
    await expect(startOpenCodeService(child.options)).rejects.toThrow(
      "startup was cancelled",
    );
    await assertStopped(child.pid());
  });

  it("aborts a stalled health request and joins its owned service on cancellation", async () => {
    const child = fixture();
    let reachedProbe: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      reachedProbe = resolve;
    });
    let aborted = false;
    const running = startOpenCodeService({
      ...child.options,
      fetch: vi.fn(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(init.signal?.reason);
              },
              { once: true },
            );
            reachedProbe?.();
          }),
      ),
    });
    await started;
    child.controller.abort();
    await expect(running).rejects.toThrow("startup was cancelled");
    expect(aborted).toBe(true);
    await assertStopped(child.pid());
  });

  it.each(["registration", "readiness"])(
    "keeps %s failure and uncertain cleanup as separate causes",
    async (origin) => {
      const child = fixture();
      const original = Object.freeze(
        new OpenCodeServiceStartupError("registration failed"),
      );
      vi.spyOn(ownership, "terminateOwnedProcess").mockRejectedValue(
        new Error("inspection unavailable"),
      );
      await expect(
        startOpenCodeService({
          ...child.options,
          startupTimeoutMs: 200,
          ...(origin === "registration"
            ? {
                onOwnedProcessAcquired: async () => {
                  throw original;
                },
              }
            : {
                fetch: vi.fn(async () => new Response(null, { status: 503 })),
              }),
        }),
      ).rejects.toMatchObject({
        cause:
          origin === "registration"
            ? original
            : expect.objectContaining({
                message: expect.stringContaining("did not become ready"),
              }),
        cleanupFailure: { cause: expect.any(Error) },
      });
      // Retain uncertainty until the fixture's known child handle cleans it up.
      expect(() => process.kill(child.pid()!, 0)).not.toThrow();
    },
  );

  it("kills a resistant leader and descendant, preserving foreign work", async () => {
    const child = fixture(
      undefined,
      `const {spawn}=require('node:child_process');
      process.on('SIGTERM',()=>{});
      spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], {stdio:'ignore'});
      process.stdout.write('opencode server listening on http://127.0.0.1:4173\\n');
      setInterval(()=>{},1000);`,
    );
    // Keep the leader alive until readiness so its birth identity is captured.
    const service = await startOpenCodeService(child.options);
    const foreign = spawn(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      { stdio: "ignore" },
    );
    try {
      await service.close();
      await assertStopped(child.pid());
      expect(foreign.pid).toBeDefined();
      expect(() => process.kill(foreign.pid!, 0)).not.toThrow();
    } finally {
      if (foreign.exitCode === null) {
        const exited = new Promise<void>((resolve) =>
          foreign.once("exit", () => resolve()),
        );
        foreign.kill("SIGKILL");
        await exited;
      }
      await service.close();
    }
  });

  it("fails a missing executable promptly", async () => {
    const start = () => spawn("/seqlane-missing-opencode-fixture", []);
    await expect(
      startOpenCodeService({
        workspace: process.cwd(),
        signal: new AbortController().signal,
        spawn: start,
      }),
    ).rejects.toMatchObject({
      name: "OpenCodeServiceStartupError",
      message: expect.stringContaining("executable is unavailable"),
      cause: expect.any(Error),
    });
  });

  it("keeps only the last 16 KiB of native output", async () => {
    const child = fixture(
      undefined,
      "process.stdout.write('opencode server listening on http://127.0.0.1:4173\\n'); setTimeout(() => process.stderr.write('€'.repeat(11000)), 100); setInterval(() => {}, 1000);",
    );
    const service = await startOpenCodeService(child.options);
    try {
      await expect
        .poll(() => service.diagnostics().includes("€"), { timeout: 2_000 })
        .toBe(true);
      expect(Buffer.byteLength(service.diagnostics())).toBeLessThanOrEqual(
        16 * 1024,
      );
    } finally {
      await service.close();
    }
  });
});
