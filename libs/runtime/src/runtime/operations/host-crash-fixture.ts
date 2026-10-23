import { appendFileSync, writeFileSync } from "node:fs";
import type { Plan } from "@seqlane/core";
import { z } from "zod";
import { createNativeOperationalHost } from "./host.js";
import { createOperationalWorkflow } from "./registration.js";

const [storageUrl, readyPath, counterPath] = process.argv.slice(2);
if (
  storageUrl === undefined ||
  readyPath === undefined ||
  counterPath === undefined
) {
  throw new Error("Expected storage URL, ready file, and counter file");
}

const input = z.string();
const output = z.string();
const taskId = "crash-fixture.task";
const nodeId = `${taskId}:1`;
const plan: Plan = {
  workflow: { id: "crash-fixture" },
  nodes: [
    {
      type: "task",
      taskId,
      nodeId,
      workspace: "exclusive",
      input: { type: "ref", nodeId: "__seqlane_input", path: [] },
      dependsOn: [],
    },
  ],
  output: { type: "ref", nodeId, path: [] },
};
const workflow = createOperationalWorkflow({
  key: "crash-fixture",
  plan,
  workflow: { input, output },
  taskDefinitions: new Map([
    [
      taskId,
      {
        id: taskId,
        input,
        output,
        execute: async () => {
          appendFileSync(counterPath, "invoked\n");
          await new Promise<never>(() => undefined);
        },
      },
    ],
  ]),
});
const host = await createNativeOperationalHost({
  workflows: [workflow],
  storageUrl,
  port: 0,
});
const address = await host.listen();
writeFileSync(
  readyPath,
  JSON.stringify({ address, port: host.port, pid: process.pid }),
);
