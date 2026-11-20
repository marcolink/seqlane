import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { defineTask } from "@seqlane/core";
import {
  startOpenCodeV2Service,
  createOpenCodeV2AgentRuntimeFactory,
} from "@seqlane/opencode-adapter/v2";
const executable = process.env.SEQLANE_OPENCODE_V2_EXECUTABLE;
assert(
  executable && isAbsolute(executable),
  "Set SEQLANE_OPENCODE_V2_EXECUTABLE to an absolute pinned binary path",
);
const root = await mkdtemp(join(tmpdir(), "seqlane-v2-native-questions-"));
const workspace = join(root, "workspace");
let modelCalls = 0;
let toolResult;
const provider = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = z
    .object({
      tools: z.array(z.unknown()).optional(),
      messages: z.array(
        z.object({ role: z.string(), content: z.unknown().optional() }),
      ),
    })
    .parse(JSON.parse(raw));
  const agent = body.tools !== undefined;
  if (agent) modelCalls++;
  const answered = body.messages.find((message) => message.role === "tool");
  if (answered) toolResult = JSON.stringify(answered);
  const ask = agent && !answered;
  const delta = ask
    ? {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call_question",
            type: "function",
            function: {
              name: "question",
              arguments: JSON.stringify({
                questions: [
                  { header: "Name", question: "What name?", options: [] },
                  {
                    header: "Choice",
                    question: "Choose an option",
                    options: [
                      { label: "One", description: "First" },
                      { label: "Two", description: "Second" },
                    ],
                  },
                ],
              }),
            },
          },
        ],
      }
    : { role: "assistant", content: '{"answer":"ok"}' };
  const base = {
    id: `completion_${modelCalls}`,
    object: "chat.completion.chunk",
    created: 1,
    model: "fixture",
  };
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
    {
      ...base,
      choices: [
        { index: 0, delta: {}, finish_reason: ask ? "tool_calls" : "stop" },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  ])
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end("data: [DONE]\n\n");
});
let service;
let runtime;
const calls = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? input : input.url,
  );
  calls.push({ path: url.pathname, method: init?.method ?? "GET" });
  return originalFetch(input, init);
};
try {
  await mkdir(workspace, { recursive: true });
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
  const configuration = {
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
  };
  await writeFile(
    join(root, "config", "opencode", "opencode.json"),
    JSON.stringify(configuration),
  );
  service = await startOpenCodeV2Service({
    workspace,
    executable,
    signal: AbortSignal.timeout(60000),
  });
  runtime = await createOpenCodeV2AgentRuntimeFactory({
    adapter: "opencode-v2",
    url: service.url,
    authorization: service.authorization,
  })(new AbortController().signal, workspace);
  const task = defineTask({
    id: "native-question-proof",
    input: z.object({}),
    output: z.object({ answer: z.string() }),
    execute: async () => ({ answer: "unused" }),
  });
  const adapter = runtime.createAdapter({
    signal: new AbortController().signal,
  });
  let callbacks = 0;
  const output = await adapter.execute({
    invocationId: "proof",
    task,
    input: {},
    agent: { goal: 'Return exactly {"answer":"ok"}', instructions: [] },
    signal: AbortSignal.timeout(30000),
    onExecutionStarted() {},
    async requestUserInput(request) {
      callbacks++;
      assert.equal(request.questions.length, 2);
      assert.equal(request.questions[0].allowFreeText, true);
      assert.equal(request.questions[1].options.length, 2);
      return {
        status: "answered",
        answers: {
          [request.questions[0].id]: "Ada",
          [request.questions[1].id]: request.questions[1].options[1].value,
        },
      };
    },
  });
  assert.deepEqual(output, { answer: "ok" });
  assert.equal(callbacks, 1);
  assert.equal(calls.filter((call) => call.path.endsWith("/prompt")).length, 1);
  assert.equal(calls.filter((call) => call.path.endsWith("/reply")).length, 1);
  assert.equal(modelCalls, 2);
  assert(toolResult?.includes("Ada"));
  assert(toolResult?.includes("Two"));
  const success = {
    status: "passed",
    nativeVersion: "2.1.2",
    callbacks,
    prompts: 1,
    replies: 1,
    modelCalls,
    canonicalIDsMappedBack: true,
    output,
  };
  const cancelled = new AbortController();
  const cancellingAdapter = runtime.createAdapter({
    signal: new AbortController().signal,
  });
  const start = calls.length;
  let cancelledCallbacks = 0;
  const failure = await cancellingAdapter
    .execute({
      invocationId: "cancel-proof",
      task,
      input: {},
      agent: { goal: 'Return exactly {"answer":"ok"}', instructions: [] },
      signal: AbortSignal.any([cancelled.signal, AbortSignal.timeout(30000)]),
      onExecutionStarted() {},
      requestUserInput() {
        cancelledCallbacks++;
        queueMicrotask(() => cancelled.abort());
        return new Promise(() => {});
      },
    })
    .catch((cause) => cause);
  assert(failure instanceof Error);
  assert.equal(cancelledCallbacks, 1);
  const cancelCalls = calls.slice(start);
  const cancelIndex = cancelCalls.findIndex(
    (call) => call.method === "DELETE" && call.path.includes("/form/"),
  );
  const interruptIndex = cancelCalls.findIndex((call) =>
    call.path.endsWith("/interrupt"),
  );
  assert(cancelIndex >= 0);
  assert(interruptIndex > cancelIndex);
  assert.equal(
    cancelCalls.filter((call) => call.path.endsWith("/prompt")).length,
    1,
  );
  assert.equal(
    cancelCalls.filter((call) => call.path.endsWith("/reply")).length,
    0,
  );
  const evidence = {
    success,
    cancellation: {
      status: "passed",
      callbacks: cancelledCallbacks,
      prompts: 1,
      replies: 0,
      nativeFormCancelledBeforeOwnedInterrupt: true,
    },
  };
  console.log(JSON.stringify(evidence));
} finally {
  globalThis.fetch = originalFetch;
  try {
    await runtime?.close?.();
  } finally {
    try {
      await service?.close?.();
    } finally {
      provider.closeAllConnections();
      await new Promise((resolve) => provider.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  }
}
