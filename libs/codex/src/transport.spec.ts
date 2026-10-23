// @test-scope ./transport.ts
// @test-scope ./protocol.ts
// @test-scope ../../adapter/src/private/owned-process/identity.ts
import {
  execFileSync,
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { CodexRequestDeadlineError } from "./deadline.js";
import { CodexAdapterError, CodexProtocolError } from "./errors.js";
import { confirmOwnedProcessGroupStopped } from "@seqlane/agent-adapter/private/owned-process";
import {
  MAX_JSONL_OUTBOUND_PARAMS_BYTES,
  unsupportedCodexServerRequest,
} from "./protocol.js";
import {
  createCodexStdioTransport,
  createCodexTransportForProcess,
  type CodexTransport,
} from "./transport.js";

const initializeResult = {
  userAgent: "codex-cli/0.147.0",
  codexHome: "/tmp/codex",
  platformFamily: "unix",
  platformOs: "macos",
};
const processIdsSchema = z.object({
  leaderPid: z.number().int().positive(),
  descendantPid: z.number().int().positive(),
});

const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (!child.killed) child.kill();
  }
});

function spawnServer(body: string): ChildProcessWithoutNullStreams {
  const source = `
    const readline = require("node:readline");
    const input = readline.createInterface({ input: process.stdin });
    input.on("line", (line) => {
      const message = JSON.parse(line);
      ${body}
    });
  `;
  const child = spawn(process.execPath, ["-e", source], {
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  children.push(child);
  return child;
}

function recordWrites(child: ChildProcessWithoutNullStreams): string[] {
  const writes: string[] = [];
  const write = child.stdin.write.bind(child.stdin);
  child.stdin.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    writes.push(String(chunk));
    return (write as (...writeArgs: unknown[]) => boolean)(chunk, ...args);
  }) as typeof child.stdin.write;
  return writes;
}

function writeResponse(result: unknown, id: string): string {
  return `process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: ${id}, result: ${JSON.stringify(result)} }) + "\\n");`;
}

async function createTransport(body: string): Promise<{
  child: ChildProcessWithoutNullStreams;
  transport: CodexTransport;
}> {
  const child = spawnServer(body);
  const transport = await createCodexTransportForProcess(child);
  return { child, transport };
}

describe("Codex app-server transport", () => {
  it("registers cancellation before an outbound write can abort synchronously", async () => {
    const { child, transport } = await createTransport(`
      if (message.method === "initialize") { ${writeResponse(initializeResult, "message.id")} }
      else if (message.id !== undefined) { ${writeResponse({ ok: true }, "message.id")} }
    `);
    const controller = new AbortController();
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
      if (String(chunk).includes('"method":"cancel-during-write"'))
        controller.abort(false);
      return (write as (...values: unknown[]) => boolean)(chunk, ...args);
    }) as typeof child.stdin.write;
    await expect(
      transport.request("cancel-during-write", {}, controller.signal),
    ).rejects.toBe(false);
    // The cancelled response remains a known tombstone; the same connection survives it.
    await expect(transport.request("next", {})).resolves.toEqual({ ok: true });
    await transport.close();
  });

  it("surfaces a safe request rejection while retaining the server error as cause", async () => {
    const { transport } = await createTransport(`
      if (message.method === "initialize") {
        ${writeResponse(initializeResult, "message.id")}
      } else if (message.method === "thread/start") {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32600, message: "unknown sandbox variant" },
        }) + "\\n");
      }
    `);

    await expect(transport.request("thread/start", {})).rejects.toMatchObject({
      code: "execution",
      message:
        "Codex adapter: Codex app-server rejected thread/start (code -32600): invalid request",
      cause: { code: -32600, message: "unknown sandbox variant" },
    });
    await transport.close();
  });

  it("does not expose hostile server text or request names in errors", async () => {
    const hostileMessage = `secret-value\n\u001b[31mforged\u001b[0m${"x".repeat(2_000)}`;
    const { transport } = await createTransport(`
      if (message.method === "initialize") {
        ${writeResponse(initializeResult, "message.id")}
      } else if (message.id !== undefined) {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32602, message: ${JSON.stringify(hostileMessage)} },
        }) + "\\n");
      }
    `);

    await expect(
      transport.request("thread/start\n\u001b[31m", {}),
    ).rejects.toMatchObject({
      message:
        "Codex adapter: Codex app-server rejected request (code -32602): invalid parameters",
      cause: { code: -32602, message: hostileMessage },
    });
    await transport.close();
  });

  it("preserves notification ordering when response and notification share a chunk", async () => {
    const { transport } = await createTransport(`
      if (message.method === "initialize") {
        ${writeResponse(initializeResult, "message.id")}
      } else if (message.method === "initialized") {
        // Continue serving requests.
      } else if (message.method === "probe") {
        process.stdout.write(
          JSON.stringify({ jsonrpc: "2.0", method: "test/event", params: { value: 1 } }) + "\\n" +
          JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } }) + "\\n",
        );
      }
    `);
    const messages: string[] = [];
    const unsubscribe = transport.subscribe((message) => {
      if (message.kind === "notification")
        messages.push(message.notification.method);
    });

    await expect(transport.request("probe", {})).resolves.toEqual({ ok: true });
    expect(messages).toEqual(["test/event"]);
    unsubscribe();
    await transport.close();
  });

  it("terminates the child and waits for close after a malformed initialize result", async () => {
    const child = spawnServer(`
      if (message.method === "initialize") {
        ${writeResponse({ userAgent: "missing fields" }, "message.id")}
      }
    `);
    let closed = false;
    child.once("close", () => {
      closed = true;
    });

    await expect(createCodexTransportForProcess(child)).rejects.toThrow(
      CodexProtocolError,
    );
    expect(closed).toBe(true);
  });

  it("closes a rejected registration without sending protocol messages", async () => {
    const child = spawnServer(`
    `);
    const writes = recordWrites(child);
    let closed = false;
    child.once("close", () => {
      closed = true;
    });
    const registrationError = new Error("process registration failed");

    await expect(
      createCodexStdioTransport(
        {
          executable: process.execPath,
          workspace: process.cwd(),
          networkAccess: false,
        },
        {
          spawnProcess: () => child,
          onOwnedProcessAcquired: async () => {
            throw registrationError;
          },
        },
      ),
    ).rejects.toBe(registrationError);
    expect(closed).toBe(true);
    expect(writes).toEqual([]);
  });

  it("waits for registration acknowledgement before protocol writes", async () => {
    const child = spawnServer(`
      if (message.method === "initialize") {
        ${writeResponse(initializeResult, "message.id")}
      } else if (message.method === "initialized") {
        // Continue serving requests.
      }
    `);
    const writes = recordWrites(child);
    let acknowledge!: () => void;
    const acknowledgement = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const creation = createCodexStdioTransport(
      {
        executable: process.execPath,
        workspace: process.cwd(),
        networkAccess: false,
      },
      {
        spawnProcess: () => child,
        onOwnedProcessAcquired: () => acknowledgement,
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(writes).toEqual([]);
    acknowledge();
    const transport = await creation;
    expect(writes.map((line) => JSON.parse(line).method)).toEqual([
      "initialize",
      "initialized",
    ]);
    await transport.close();
  });

  it.skipIf(process.platform === "win32")(
    "terminates the owned app-server group and preserves a foreign group",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "seqlane-codex-group-"));
      const executable = join(directory, "codex-fixture");
      const pidFile = join(directory, "processes.json");
      writeFileSync(
        executable,
        `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.147.0\\n");
} else {
  const { appendFileSync } = require("node:fs");
  const { spawn } = require("node:child_process");
  const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
  process.on("SIGTERM", () => {});
  appendFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ leaderPid: process.pid, descendantPid: descendant.pid }));
  const readline = require("node:readline");
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "initialize") process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: message.id, result: ${JSON.stringify(initializeResult)}
    }) + "\\n");
  });
}
`,
        { mode: 0o755 },
      );

      const foreign = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { detached: true, stdio: "ignore" },
      );
      children.push(foreign);
      let registeredPid: number | undefined;
      let transport: CodexTransport | undefined;
      try {
        transport = await createCodexStdioTransport(
          { executable, workspace: directory, networkAccess: false },
          {
            onOwnedProcessAcquired: async (pid) => {
              registeredPid = pid;
              const group = execFileSync(
                "ps",
                ["-o", "pgid=", "-p", `${pid}`],
                { encoding: "utf8" },
              ).trim();
              expect(Number(group)).toBe(pid);
            },
          },
        );
        expect(registeredPid).toBeGreaterThan(0);
        const processIds = processIdsSchema.parse(
          JSON.parse(readFileSync(pidFile, "utf8")),
        );
        expect(processIds.leaderPid).toBe(registeredPid);
        expect(processIds.descendantPid).not.toBe(processIds.leaderPid);
        await transport.close();
        expect(await confirmOwnedProcessGroupStopped(registeredPid!)).toBe(
          true,
        );
        expect(() => process.kill(foreign.pid!, 0)).not.toThrow();
      } finally {
        await transport?.close().catch(() => undefined);
        try {
          foreign.kill("SIGKILL");
        } catch {
          // The foreign process may already have exited.
        }
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "retains cleanup uncertainty when the leader exits before its descendant",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "seqlane-codex-orphan-"));
      const executable = join(directory, "codex-fixture");
      const pidFile = join(directory, "processes.json");
      writeFileSync(
        executable,
        `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.147.0\\n");
} else {
  const { appendFileSync } = require("node:fs");
  const { spawn } = require("node:child_process");
  const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
  process.on("SIGTERM", () => {});
  appendFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ leaderPid: process.pid, descendantPid: descendant.pid }));
  const readline = require("node:readline");
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "initialize") process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: message.id, result: ${JSON.stringify(initializeResult)}
    }) + "\\n");
  });
}
`,
        { mode: 0o755 },
      );

      let registeredPid: number | undefined;
      let transport: CodexTransport | undefined;
      let descendantPid: number | undefined;
      try {
        transport = await createCodexStdioTransport(
          { executable, workspace: directory, networkAccess: false },
          {
            onOwnedProcessAcquired: async (pid) => {
              registeredPid = pid;
            },
          },
        );
        const processIds = processIdsSchema.parse(
          JSON.parse(readFileSync(pidFile, "utf8")),
        );
        descendantPid = processIds.descendantPid;
        expect(processIds.leaderPid).toBe(registeredPid);
        process.kill(processIds.leaderPid, "SIGKILL");
        await transport.termination.catch(() => undefined);

        await expect(transport.close()).rejects.toMatchObject({
          cause: {
            message: "Could not confirm Codex app-server process group stopped",
          },
        });
        expect(await confirmOwnedProcessGroupStopped(registeredPid!)).toBe(
          false,
        );
        expect(() => process.kill(processIds.descendantPid, 0)).not.toThrow();
      } finally {
        if (registeredPid !== undefined) {
          try {
            process.kill(-registeredPid, "SIGKILL");
          } catch {
            // The verified owned group may already have stopped.
          }
        }
        await transport?.close().catch(() => undefined);
        if (descendantPid !== undefined) {
          try {
            process.kill(descendantPid, "SIGKILL");
          } catch {
            // The owned descendant may already have exited.
          }
        }
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("preserves null, undefined, and frozen registration failures", async () => {
    for (const registrationError of [
      null,
      undefined,
      Object.freeze(new Error("frozen registration failure")),
    ]) {
      const child = spawnServer(``);
      const writes = recordWrites(child);
      await expect(
        createCodexStdioTransport(
          {
            executable: process.execPath,
            workspace: process.cwd(),
            networkAccess: false,
          },
          {
            spawnProcess: () => child,
            onOwnedProcessAcquired: async () => {
              throw registrationError;
            },
          },
        ),
      ).rejects.toBe(registrationError);
      expect(writes).toEqual([]);
    }
  });

  it("bounds an unresponsive initialize handshake and terminates the child", async () => {
    const child = spawnServer(`
      if (message.method === "initialize") {
        // Keep the handshake unresolved.
      }
    `);
    let closed = false;
    child.once("close", () => {
      closed = true;
    });

    await expect(
      createCodexTransportForProcess(child, { initializeTimeoutMs: 10 }),
    ).rejects.toBeInstanceOf(CodexRequestDeadlineError);
    expect(closed).toBe(true);
  });

  it("cancels an unresponsive initialize handshake and terminates the child", async () => {
    const child = spawnServer(`
      if (message.method === "initialize") {
        // Keep the handshake unresolved.
      }
    `);
    const controller = new AbortController();
    let closed = false;
    child.once("close", () => {
      closed = true;
    });

    const creation = createCodexTransportForProcess(child, {
      signal: controller.signal,
      initializeTimeoutMs: 1_000,
    });
    controller.abort(new Error("fixture initialization cancelled"));

    await expect(creation).rejects.toThrow("fixture initialization cancelled");
    expect(closed).toBe(true);
  });

  it("resolves close and termination only after the child closes", async () => {
    const { child, transport } = await createTransport(`
      if (message.method === "initialize") {
        ${writeResponse(initializeResult, "message.id")}
      }
    `);
    let closed = false;
    child.once("close", () => {
      closed = true;
    });

    await transport.close();
    expect(closed).toBe(true);
    await expect(transport.termination).resolves.toBeUndefined();
  });

  it("drains stderr while the child emits more than the pipe capacity", async () => {
    const { transport } = await createTransport(`
      if (message.method === "initialize") {
        process.stderr.write("x".repeat(2 * 1024 * 1024));
        ${writeResponse(initializeResult, "message.id")}
      }
    `);

    await transport.close();
  }, 10_000);

  it("decodes a UTF-8 character split across stdout chunks", async () => {
    const { transport } = await createTransport(`
      if (message.method === "initialize") {
        ${writeResponse(initializeResult, "message.id")}
      } else if (message.method === "initialized") {
        // Continue serving requests.
      } else if (message.method === "probe") {
        const payload = JSON.stringify({
          jsonrpc: "2.0",
          method: "test/event",
          params: { value: "€" },
        });
        const bytes = Buffer.from(payload + "\\n");
        const split = bytes.indexOf(Buffer.from("€")) + 1;
        process.stdout.write(bytes.subarray(0, split));
        setTimeout(() => {
          process.stdout.write(bytes.subarray(split));
          ${writeResponse({ ok: true }, "message.id")}
        }, 0);
      }
    `);
    const values: unknown[] = [];
    transport.subscribe((message) => {
      if (message.kind === "notification") {
        values.push((message.notification.params as { value: string }).value);
      }
    });

    await expect(transport.request("probe", {})).resolves.toEqual({ ok: true });
    expect(values).toEqual(["€"]);
    await transport.close();
  });

  it("responds to a server request with a typed rejection", async () => {
    const { transport } = await createTransport(`
      if (message.method === "initialize") {
        ${writeResponse(initializeResult, "message.id")}
      } else if (message.method === "initialized") {
        // Continue serving requests.
      } else if (message.method === "probe") {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          id: 99,
          method: "item/commandExecution/requestApproval",
          params: { threadId: "thread-1", turnId: "turn-1" },
        }) + "\\n");
      } else if (message.id === 99 && message.method === undefined) {
        if (message.error?.code === -32601) {
          ${writeResponse({ ok: true }, "2")}
        }
      }
    `);
    const unsubscribe = transport.subscribe((message) => {
      if (message.kind === "server-request") {
        transport.respond(
          message.request.id,
          unsupportedCodexServerRequest(message.request),
        );
      }
    });

    await expect(transport.request("probe", {})).resolves.toEqual({ ok: true });
    unsubscribe();
    await transport.close();
  });

  it("fails pending requests when a subscriber throws", async () => {
    const { child, transport } = await createTransport(`
      if (message.method === "initialize") {
        ${writeResponse(initializeResult, "message.id")}
      } else if (message.method === "initialized") {
        // Continue serving requests.
      } else if (message.method === "probe") {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          method: "test/event",
          params: {},
        }) + "\\n");
      }
    `);
    transport.subscribe(() => {
      throw new Error("subscriber failed");
    });

    await expect(transport.request("probe", {})).rejects.toMatchObject({
      code: "execution",
      message: expect.stringContaining("message delivery failed"),
    });
    await expect(transport.termination).rejects.toMatchObject({
      code: "execution",
      message: expect.stringContaining("message delivery failed"),
    });
    expect(child.killed || child.signalCode !== null).toBe(true);
  });

  it("escalates shutdown to SIGKILL when the child ignores SIGTERM", async () => {
    const { child, transport } = await createTransport(`
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1_000);
      if (message.method === "initialize") {
        ${writeResponse(initializeResult, "message.id")}
      }
    `);

    await transport.close();
    expect(child.signalCode).toBe("SIGKILL");
  }, 5_000);

  it("ignores a response for an aborted request", async () => {
    const { transport } = await createTransport(`
      if (message.method === "initialize") {
        ${writeResponse(initializeResult, "message.id")}
      } else if (message.method === "initialized") {
        // Continue serving requests.
      } else if (message.method === "cancel") {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { late: true },
        }) + "\\n");
      } else if (message.method === "probe") {
        ${writeResponse({ ok: true }, "message.id")}
      }
    `);
    const controller = new AbortController();
    const request = transport.request("cancel", {}, controller.signal);
    controller.abort();

    await expect(request).rejects.toThrow("aborted");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(transport.request("probe", {})).resolves.toEqual({ ok: true });
    await transport.close();
  });

  it("bounds the retained aborted request IDs", async () => {
    const { transport } = await createTransport(`
      const cancelled = [];
      if (message.method === "initialize") {
        ${writeResponse(initializeResult, "message.id")}
      } else if (message.method === "initialized") {
        // Continue serving requests.
      } else if (message.method === "cancel") {
        cancelled.push(message.id);
        if (cancelled.length === 1_025) {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: cancelled[0],
            result: { late: true },
          }) + "\\n");
        }
      } else if (message.method === "probe") {
        ${writeResponse({ ok: true }, "message.id")}
      }
    `);
    const requests: Promise<unknown>[] = [];
    for (let index = 0; index < 1_025; index += 1) {
      const controller = new AbortController();
      const request = transport.request("cancel", {}, controller.signal);
      controller.abort();
      requests.push(request.catch(() => undefined));
    }
    await Promise.all(requests);
    await new Promise((resolve) => setTimeout(resolve, 50));

    await expect(transport.request("probe", {})).resolves.toEqual({ ok: true });
    await transport.close();
  });

  it("rejects oversized outbound params with a typed limit error", async () => {
    const { transport } = await createTransport(`
      if (message.method === "initialize") {
        ${writeResponse(initializeResult, "message.id")}
      }
    `);

    await expect(
      transport.request("probe", {
        prompt: "x".repeat(MAX_JSONL_OUTBOUND_PARAMS_BYTES),
      }),
    ).rejects.toBeInstanceOf(CodexAdapterError);
    await expect(
      transport.request("probe", {
        prompt: "x".repeat(MAX_JSONL_OUTBOUND_PARAMS_BYTES),
      }),
    ).rejects.toMatchObject({ code: "limit" });
    await transport.close();
  });
});
