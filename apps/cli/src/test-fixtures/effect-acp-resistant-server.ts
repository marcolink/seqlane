import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { z } from "zod";

const environmentSchema = z.strictObject({
  trace: z.string().min(1),
  pidFile: z.string().min(1),
});
const environment = environmentSchema.parse({
  trace: process.env.SEQLANE_ACP_FIXTURE_TRACE,
  pidFile: process.env.SEQLANE_ACP_FIXTURE_PID_FILE,
});
const requestSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().min(1).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  result: z.unknown().optional(),
});
const configOptions = (currentValue: string) => [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue,
    options: [
      { value: "fixture-default", name: "Default" },
      { value: "fixture-model", name: "Fixture" },
    ],
  },
];
let selectedModel = "fixture-default";

function record(event: string, details: Record<string, unknown> = {}): void {
  appendFileSync(
    environment.trace,
    `${JSON.stringify({ event, ...details })}\n`,
  );
}

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id: string | number, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

const resistantGrandchild = [
  'process.on("SIGTERM", () => undefined);',
  'process.on("SIGINT", () => undefined);',
  "setInterval(() => undefined, 1_000);",
].join("\n");
const grandchild = spawn(process.execPath, ["-e", resistantGrandchild], {
  stdio: "ignore",
});
if (grandchild.pid === undefined) throw new Error("Grandchild has no PID");
process.on("SIGTERM", () => undefined);
process.on("SIGINT", () => undefined);
writeFileSync(
  environment.pidFile,
  JSON.stringify({ sdkPid: process.pid, grandchildPid: grandchild.pid }),
);
record("process.started", { pid: process.pid, grandchildPid: grandchild.pid });

let inputBuffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  inputBuffer += chunk;
  while (true) {
    const newline = inputBuffer.indexOf("\n");
    if (newline < 0) break;
    const line = inputBuffer.slice(0, newline);
    inputBuffer = inputBuffer.slice(newline + 1);
    if (line.length === 0) continue;
    const message = requestSchema.parse(JSON.parse(line));
    if (message.method === undefined) continue;
    record(message.method, { params: message.params });
    if (message.id === undefined) continue;
    switch (message.method) {
      case "initialize":
        respond(message.id, {
          protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: { close: {} } },
          authMethods: [],
          agentInfo: {
            name: "seqlane-resistant-acp-fixture",
            version: "1.0.0",
          },
        });
        break;
      case "session/new":
        respond(message.id, {
          sessionId: "resistant-fixture-session",
          configOptions: configOptions(selectedModel),
        });
        break;
      case "session/set_config_option":
        selectedModel = z.string().parse(message.params?.value);
        respond(message.id, { configOptions: configOptions(selectedModel) });
        break;
      case "session/prompt":
        // Keep the native SDK request unsettled so the CLI reaches forced cleanup.
        break;
      case "session/cancel":
        // Deliberately ignore cancellation; the supervisor must stop this tree.
        break;
      default:
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32601,
            message: `Unsupported fixture method: ${message.method}`,
          },
        });
    }
  }
});
