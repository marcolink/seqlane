// @test-scope ./transport.ts
// @test-scope ./protocol.ts
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { CodexRequestDeadlineError } from "./deadline.js";
import { CodexAdapterError, CodexProtocolError } from "./errors.js";
import {
  MAX_JSONL_OUTBOUND_PARAMS_BYTES,
  unsupportedCodexServerRequest,
} from "./protocol.js";
import {
  createCodexTransportForProcess,
  type CodexTransport,
} from "./transport.js";

const initializeResult = {
  userAgent: "codex-cli/0.147.0",
  codexHome: "/tmp/codex",
  platformFamily: "unix",
  platformOs: "macos",
};

const children: ChildProcessWithoutNullStreams[] = [];

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
    await expect(transport.termination).resolves.toBeUndefined();
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
