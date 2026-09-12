import { spawn } from "node:child_process";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AppServerClient,
  parseJsonLine,
  runProbe,
} from "./codex-app-server-probe.mjs";

const children = [];
const temporaryDirectories = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  return Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function spawnServer() {
  const source = `
    const readline = require("node:readline");
    const input = readline.createInterface({ input: process.stdin });
    input.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "probe") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "probe/event", params: { value: 1 } }) + "\\n");
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } }) + "\\n");
      }
    });
  `;
  const child = spawn(process.execPath, ["-e", source], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  return child;
}

async function createFakeExecutable() {
  const directory = await mkdtemp("/private/tmp/seqlane-codex-probe-");
  temporaryDirectories.push(directory);
  const server = join(directory, "codex-fake.mjs");
  const executable = join(directory, "codex-fake");
  await writeFile(
    server,
    `
    import readline from "node:readline";
    if (process.argv[2] === "--version") {
      console.log("codex-cli 0.147.0");
      process.exit(0);
    }
    const input = readline.createInterface({ input: process.stdin });
    let threadNumber = 0;
    let turnNumber = 0;
    input.on("line", (line) => {
      const message = JSON.parse(line);
      const respond = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
      if (message.method === "initialize") respond({ userAgent: "codex-cli 0.147.0", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "test" });
      else if (message.method === "model/list") respond({ data: [{ id: "openai/gpt-test", model: "gpt-test", supportedReasoningEfforts: [{ reasoningEffort: "high" }], isDefault: true }] });
      else if (message.method === "thread/start") {
        threadNumber += 1;
        respond({ thread: { id: "thread-" + threadNumber } });
      } else if (message.method === "thread/fork") respond({ thread: { id: "thread-fork" } });
      else if (message.method === "turn/start") {
        turnNumber += 1;
        const turnId = "turn-" + turnNumber;
        respond({ turn: { id: turnId, status: "inProgress", items: [] } });
        if (message.params.input[0].text.startsWith("Return exactly")) {
          setImmediate(() => {
            process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "item/completed", params: { threadId: message.params.threadId, turnId, item: { id: "item-" + turnId, type: "agentMessage", text: JSON.stringify({ ok: true, version: "probe" }) } } }) + "\\n");
            process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: turnId, status: "completed", items: [] } } }) + "\\n");
          });
        } else if (message.params.approvalPolicy === "on-request") {
          setImmediate(() => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "item/commandExecution/requestApproval", params: { threadId: message.params.threadId, turnId } }) + "\\n"));
        }
      } else if (message.method === "turn/interrupt") {
        respond({});
        setImmediate(() => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: message.params.turnId, status: "interrupted", items: [] } } }) + "\\n"));
      }
    });
  `,
    "utf8",
  );
  await writeFile(
    executable,
    `#!/bin/sh
exec ${process.execPath} ${server} "$@"
`,
    "utf8",
  );
  await chmod(executable, 0o755);
  return { executable, server };
}

describe("Codex app-server protocol probe client", () => {
  it("parses only object JSONL messages", () => {
    assert.deepEqual(parseJsonLine('{"ok":true}'), { ok: true });
    assert.throws(() => parseJsonLine("[]"), /not an object/);
    assert.throws(() => parseJsonLine("not-json"), /invalid JSON/);
  });

  it("keeps notifications while correlating the matching response", async () => {
    const child = spawnServer();
    const client = new AppServerClient(child);
    await assert.doesNotReject(async () => {
      const result = await client.request("probe", {}, 1_000);
      assert.deepEqual(result, { ok: true });
      assert.equal(
        client.transcript.some(
          (entry) => entry.message.method === "probe/event",
        ),
        true,
      );
    });
    await client.close();
  });

  it("runs the complete protocol sequence against a deterministic fake server", async () => {
    const { server } = await createFakeExecutable();
    const fixture = await runProbe({
      executable: "codex-fake",
      workspace: process.cwd(),
      timeoutMs: 1_000,
      readVersion: () => "0.147.0",
      spawnProcess: (_executable, args, spawnOptions) =>
        spawn(process.execPath, [server, ...args], spawnOptions),
    });
    assert.equal(fixture.version, "0.147.0");
    assert.equal(fixture.modelList.defaultModel, "gpt-test");
    assert.deepEqual(fixture.structuredOutput.output, {
      ok: true,
      version: "probe",
    });
    assert.equal(fixture.structuredOutput.terminalStatus, "completed");
    assert.equal(fixture.interrupt.terminalStatus, "interrupted");
    assert.equal(fixture.approval.decisionResponseSent, false);
    assert.equal(fixture.approval.interruptedWithoutDecision, true);
  });
});
