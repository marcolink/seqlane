import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import {
  createOpenCodeV2AgentRuntimeFactory,
  OPENCODE_V2_VERSION,
  startOpenCodeV2Service,
} from "@seqlane/opencode-adapter/v2";

const executable = process.env.SEQLANE_OPENCODE_V2_EXECUTABLE;
assert(
  executable && isAbsolute(executable),
  "Set SEQLANE_OPENCODE_V2_EXECUTABLE to an absolute pinned binary path",
);
const root = await mkdtemp(join(tmpdir(), "seqlane-v2-events-"));
const workspace = join(root, "workspace");
const started = Promise.withResolvers();
const releaseAnswer = Promise.withResolvers();
const providerInput = z.object({
  tools: z.array(z.unknown()).optional(),
  messages: z.array(z.object({ role: z.string() })),
});
const reconnected = Promise.withResolvers();
let toolStartedAt;
let agentCalls = 0;
let malformed = false;
const provider = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const input = providerInput.parse(JSON.parse(body));
  const agent = input.tools !== undefined;
  if (agent) agentCalls++;
  const tool =
    agent &&
    !malformed &&
    !input.messages.some((message) => message.role === "tool");
  if (tool) {
    await reconnected.promise;
    toolStartedAt = Date.now();
  }
  if (agent && !tool && !malformed) await releaseAnswer.promise;
  const delta = tool
    ? {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call_probe",
            type: "function",
            function: {
              name: "shell",
              arguments: JSON.stringify({ command: "sleep 2" }),
            },
          },
        ],
      }
    : {
        role: "assistant",
        content: malformed && agent ? "invalid-json" : '{"answer":"ok"}',
      };
  response.writeHead(200, { "content-type": "text/event-stream" });
  const base = {
    id: `completion_${agentCalls}`,
    object: "chat.completion.chunk",
    created: 1,
    model: "fixture",
  };
  response.write(
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
});
const originalFetch = globalThis.fetch;
const logs = [];
let service;
let runtime;
try {
  await mkdir(workspace);
  for (const kind of ["data", "config", "cache", "state"])
    process.env[`XDG_${kind.toUpperCase()}_HOME`] = join(root, kind);
  process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
  process.env.SEQLANE_V2_FIXTURE_KEY = "fixture-only";
  process.env.SEQLANE_OPENCODE_V2_ENV = "SEQLANE_V2_FIXTURE_KEY";
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const address = provider.address();
  assert(address && typeof address !== "string");
  await mkdir(join(root, "config", "opencode"), { recursive: true });
  await writeFile(
    join(root, "config", "opencode", "opencode.json"),
    JSON.stringify({
      model: "fixture/fixture",
      enabled_providers: ["fixture"],
      providers: {
        fixture: {
          name: "Fixture",
          env: ["SEQLANE_V2_FIXTURE_KEY"],
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: `http://127.0.0.1:${address.port}/v1` },
          models: {
            fixture: {
              name: "Fixture",
              capabilities: { tools: true },
              limit: { context: 100000, output: 10000 },
            },
          },
        },
      },
    }),
  );
  service = await startOpenCodeV2Service({
    executable,
    workspace,
    signal: AbortSignal.timeout(30_000),
  });
  globalThis.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname !== "/api/event") return response;
    logs.push(url);
    if (logs.length === 2) reconnected.resolve();
    if (logs.length !== 1 || !response.body) return response;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    // End the first connection after a complete frame to prove reconnect.
    return new Response(
      new ReadableStream({
        async pull(controller) {
          while (true) {
            const item = await reader.read();
            assert(
              !item.done,
              "Native event stream ended before its first frame",
            );
            text += decoder.decode(item.value, { stream: true });
            assert(Buffer.byteLength(text) <= 1_048_576);
            const end = text.lastIndexOf("\n\n");
            if (end < 0) continue;
            controller.enqueue(
              new TextEncoder().encode(text.slice(0, end + 2)),
            );
            controller.close();
            await reader.cancel();
            return;
          }
        },
        cancel: () => reader.cancel(),
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  runtime = await createOpenCodeV2AgentRuntimeFactory({
    adapter: "opencode-v2",
    url: service.url,
    authorization: service.authorization,
  })(new AbortController().signal, workspace);
  const adapter = runtime.createAdapter({
    signal: new AbortController().signal,
  });
  const task = {
    id: "live-probe",
    input: z.object({}),
    output: z.object({ answer: z.literal("ok") }),
    execute: async () => ({ answer: "ok" }),
  };
  const activity = [];
  let prompts = 0;
  const request = {
    invocationId: "live-probe",
    task,
    input: {},
    agent: { goal: "Run the shell probe and return the answer" },
    signal: AbortSignal.timeout(20_000),
    onExecutionStarted: () => prompts++,
    onActivity(value) {
      activity.push(value);
      if (value.state === "started") started.resolve();
    },
  };
  const pending = adapter.execute(request);
  pending.catch((cause) => started.reject(cause));
  try {
    await started.promise;
    assert(
      toolStartedAt !== undefined && Date.now() - toolStartedAt < 500,
      "Live tool activity must arrive before the one-second recovery read",
    );
    assert(
      !activity.some((item) => item.state === "succeeded"),
      "Tool must be visible while it runs",
    );
  } finally {
    releaseAnswer.resolve();
  }
  assert.deepEqual(await pending, { answer: "ok" });
  assert(activity.some((item) => item.state === "succeeded"));
  assert.equal(prompts, 1);
  assert.equal(
    agentCalls,
    2,
    "One tool step and one answer, without task replay",
  );
  assert(logs.length >= 2, "Adapter must reconnect the first live stream");
  console.log(
    "PASS native live activity before tool completion, stream reconnect, terminal tool state, and one admitted task",
  );
  malformed = true;
  const before = agentCalls;
  await assert.rejects(
    adapter.execute({
      ...request,
      invocationId: "malformed-probe",
      signal: AbortSignal.timeout(10_000),
    }),
    { code: "output" },
  );
  assert.equal(
    agentCalls,
    before + 1,
    "Malformed output must fail without repair or replay",
  );
  console.log(
    "PASS local Zod validation rejects malformed output without task replay",
  );
  console.log(
    `OpenCode client/server ${OPENCODE_V2_VERSION}: ${process.platform}/${process.arch}; local fake provider only`,
  );
} finally {
  releaseAnswer.resolve();
  reconnected.resolve();
  globalThis.fetch = originalFetch;
  await runtime?.close();
  await service?.close();
  provider.closeAllConnections();
  await new Promise((resolve) => provider.close(resolve));
  await rm(root, { recursive: true, force: true });
}
