import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
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
const root = await mkdtemp(join(tmpdir(), "seqlane-v2-sessions-"));
const workspace = join(root, "workspace");
const requests = [];
let modelCalls = 0;
let holdStarted;
const held = new Promise((resolve) => {
  holdStarted = resolve;
});
const provider = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const parsed = z
    .object({
      tools: z.array(z.unknown()).optional(),
      messages: z.array(z.unknown()),
    })
    .parse(JSON.parse(raw));
  modelCalls++;
  if (parsed.tools !== undefined) requests.push(parsed);
  if (
    parsed.tools !== undefined &&
    JSON.stringify(parsed.messages).includes("CANCEL_HOLD")
  ) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    holdStarted();
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  const base = {
    id: `completion_${requests.length}`,
    object: "chat.completion.chunk",
    created: 1,
    model: "fixture",
  };
  for (const event of [
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: '{"answer":"ok"}' },
          finish_reason: null,
        },
      ],
    },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  ])
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end("data: [DONE]\n\n");
});
let service;
let runtime;
try {
  await mkdir(workspace, { recursive: true });
  for (const kind of ["data", "config", "cache", "state"]) {
    process.env[`XDG_${kind.toUpperCase()}_HOME`] = join(root, kind);
  }
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
              variants: [{ id: "high" }],
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
  runtime = await createOpenCodeV2AgentRuntimeFactory({
    adapter: "opencode-v2",
    url: service.url,
    authorization: service.authorization,
  })(new AbortController().signal, workspace);
  const selection = {
    model: { provider: "fixture", model: "fixture" },
    reasoning: "high",
  };
  const adapter = runtime.createAdapter({
    signal: new AbortController().signal,
    modelSelection: selection,
  });
  const output = z.object({ answer: z.literal("ok") });
  const task = defineTask({
    id: "native-sessions",
    input: z.object({ marker: z.string() }),
    output,
    execute: async () => ({ answer: "ok" }),
  });
  const invoke = (target, marker, signal = AbortSignal.timeout(30_000)) =>
    target.execute({
      invocationId: marker,
      task,
      input: { marker },
      agent: {
        goal: 'Return exactly {"answer":"ok"}',
        instructions: ["Preserve native history"],
      },
      signal,
      onExecutionStarted() {
        /* Native admission is asserted by the task result. */
      },
    });
  const sessionsSchema = z.object({
    data: z.array(
      z.object({
        id: z.string(),
        parentID: z.string().optional(),
        fork: z.object({ sessionID: z.string() }).optional(),
      }),
    ),
  });
  const list = async () =>
    sessionsSchema.parse(
      await (
        await fetch(`${service.url}/api/session?limit=100`, {
          headers: { authorization: service.authorization },
          signal: AbortSignal.timeout(10_000),
        })
      ).json(),
    ).data;
  await invoke(adapter, "IMMUTABLE_SOURCE_FIRST");
  assert.equal(
    (await list()).length,
    1,
    "tasks without capture allocate no snapshot",
  );
  const beforeCapture = modelCalls;
  const checkpoint = await adapter.captureCheckpoint();
  assert.equal(modelCalls, beforeCapture, "capture must not call any model");
  assert.equal(requests.length, 1, "capture must not invoke a model");
  const initialRoots = await list();
  const source = initialRoots.find((session) => session.fork === undefined);
  assert(source);
  const changed = await fetch(
    `${service.url}/api/experimental/session/${source.id}/instructions/entries/probe`,
    {
      method: "PUT",
      headers: {
        authorization: service.authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({ value: "MUTATED_NATIVE_INSTRUCTION" }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  assert.equal(changed.status, 204);
  await invoke(adapter, "MUTATED_SOURCE_SECOND");
  assert(
    JSON.stringify(requests[1].messages).includes("MUTATED_NATIVE_INSTRUCTION"),
    "source reuse must see the updated native instruction",
  );
  const beforeFork = modelCalls;
  const [left, right] = await Promise.all([
    adapter.fork({ checkpoint, modelSelection: selection }),
    adapter.fork({ checkpoint }),
  ]);
  assert.equal(requests.length, 2, "fork must not invoke a model");
  assert.equal(modelCalls, beforeFork, "fork must not call any model");
  const roots = await list();
  assert.equal(
    roots.length,
    4,
    "source, one snapshot, and two fork roots must exist",
  );
  assert(
    roots.every((session) => session.parentID === undefined),
    "native forks must be independent roots",
  );
  assert.equal(roots.filter((session) => session.fork !== undefined).length, 3);
  await assert.rejects(
    left.fork({ checkpoint }),
    /checkpoint does not belong to this session/,
  );
  await Promise.all([
    invoke(left, "LEFT_BRANCH"),
    invoke(right, "RIGHT_BRANCH"),
  ]);
  assert.equal(requests.length, 4);
  for (const branch of requests.slice(2)) {
    const history = JSON.stringify(branch.messages);
    assert(history.includes("IMMUTABLE_SOURCE_FIRST"));
    assert(
      !history.includes("MUTATED_NATIVE_INSTRUCTION"),
      "snapshot forks must retain the earlier native instruction state",
    );
    assert(
      !history.includes("MUTATED_SOURCE_SECOND"),
      "deferred forks must exclude later source reuse",
    );
    assert(
      !(history.includes("LEFT_BRANCH") && history.includes("RIGHT_BRANCH")),
      "parallel forks must have separate histories",
    );
  }
  const cancelled = new AbortController();
  const pending = invoke(left, "CANCEL_HOLD", cancelled.signal).catch(
    (cause) => cause,
  );
  await Promise.race([
    held,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("native cancellation admission timed out")),
        10_000,
      ).unref(),
    ),
  ]);
  cancelled.abort();
  assert(
    (await pending) instanceof Error,
    "cancellation must reject the invocation",
  );
  await left.close();
  assert((await list()).length > 0, "closing one fork must preserve peers");
  await invoke(right, "PEER_SURVIVED");
  await runtime.close();
  assert.deepEqual(
    await list(),
    [],
    "runtime close must remove all independent roots",
  );
  console.log(
    "PASS native V2 sessions: immutable history and instructions, parallel forks, selected model, zero capture/fork model calls, isolated cancellation, and complete root cleanup",
  );
} finally {
  try {
    await runtime?.close();
  } finally {
    try {
      await service?.close();
    } finally {
      provider.closeAllConnections();
      await new Promise((resolve) => provider.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  }
}
