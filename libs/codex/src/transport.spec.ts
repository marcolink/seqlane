// @test-scope ./transport.ts
// @test-scope ./protocol.ts
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { CodexProtocolError } from "./errors.js";
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
});
