import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  startOpenCodeV2Service,
  createOpenCodeV2AgentRuntimeFactory,
  OPENCODE_V2_VERSION,
} from "@seqlane/opencode-adapter/v2";

const executable = process.env.SEQLANE_OPENCODE_V2_EXECUTABLE;
assert(
  executable && isAbsolute(executable),
  "Set SEQLANE_OPENCODE_V2_EXECUTABLE to an absolute pinned binary path",
);
const repository = resolve(import.meta.dirname, "..");
const root = await mkdtemp(join(tmpdir(), "seqlane-opencode-v2-"));
const workflowDirectory = await mkdtemp(
  join(
    process.env.SEQLANE_V2_PROBE_WORKFLOW_ROOT ?? repository,
    ".opencode-v2-probe-",
  ),
);
const workspace = join(root, "workspace");
let agentCalls = 0;
let toolCalls = 0;
let shellMode = false;
let questionMode = false;
let responseText = '{"answer":"ok"}';
const shellObserved = Promise.withResolvers();
const rootObserved = Promise.withResolvers();
const provider = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const parsed = z
    .object({
      tools: z.array(z.unknown()).optional(),
      messages: z.array(z.object({ role: z.string() })),
    })
    .parse(JSON.parse(raw));
  const agent = parsed.tools !== undefined;
  if (agent) agentCalls++;
  const shell =
    shellMode &&
    agent &&
    !parsed.messages.some((message) => message.role === "tool");
  if (shell) toolCalls++;
  response.writeHead(200, { "content-type": "text/event-stream" });
  const base = {
    id: `completion_${agentCalls}`,
    object: "chat.completion.chunk",
    created: 1,
    model: "fixture",
  };
  const question = questionMode && agent;
  const delta = question
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
    : shell
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_shell",
              type: "function",
              function: {
                name: "shell",
                arguments: JSON.stringify({
                  command: "sleep 60",
                  background: true,
                }),
              },
            },
          ],
        }
      : { role: "assistant", content: responseText };
  for (const event of [
    { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: shell || question ? "tool_calls" : "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  ])
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end("data: [DONE]\n\n");
});
let external;
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
  const workflow = join(workflowDirectory, "workflow.mjs");
  await writeFile(
    workflow,
    `import { createFlow, defineAgentTask, isolated, reuse } from '@seqlane/core'; import { z } from 'zod';
const output = z.object({answer:z.string()});
const task = defineAgentTask({id:'probe',input:z.object({}),output,goal:()=> 'Return exactly {"answer":"ok"}'});
export default createFlow({id:'v2-probe',input:z.object({}),output,model:{model:{provider:'fixture',model:'fixture'},reasoning:'high'}})
.task('first',task,()=>({}),{session:isolated()})
.task('second',task,()=>({}),{session:({tasks})=>reuse(tasks.first.session)})
.output(({tasks})=>tasks.second.output).define();`,
  );
  const run = async (flags, adapter = "opencode-v2") => {
    const result = await promisify(execFile)(
      process.execPath,
      [
        process.env.SEQLANE_V2_PROBE_CLI ??
          join(repository, "apps/cli/bin/run.js"),
        "run",
        workflow,
        "--workspace",
        workspace,
        "--adapter",
        adapter,
        "--json",
        ...flags,
      ],
      {
        cwd: repository,
        env: process.env,
        timeout: 60_000,
        maxBuffer: 1_048_576,
      },
    );
    const value = z
      .object({
        status: z.literal("succeeded"),
        output: z.object({ answer: z.literal("ok") }),
      })
      .parse(JSON.parse(result.stdout));
    assert(!result.stdout.includes("fixture-only"));
    return value;
  };
  await run(["--opencode-v2-executable", executable]);
  assert.equal(agentCalls, 2, "managed run must execute two authored tasks");
  console.log("PASS managed CLI: typed output and ordered reuse");
  external = await startOpenCodeV2Service({
    executable,
    workspace,
    signal: AbortSignal.timeout(30_000),
  });
  const headers = { authorization: external.authorization };
  const credentialProbe = join(workspace, "credential-probe.mjs");
  await writeFile(
    credentialProbe,
    `const password = process.env.OPENCODE_SERVER_PASSWORD ?? process.env.OPENCODE_PASSWORD;
const response = await fetch(${JSON.stringify(`${external.url}/api/info`)}, {
  headers: { authorization: 'Basic ' + Buffer.from('opencode:' + (password ?? '')).toString('base64') },
  signal: AbortSignal.timeout(5000),
});
console.log(JSON.stringify({ credentialPresent: password !== undefined, serviceStatus: response.status }));
`,
  );
  const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const probeSignal = AbortSignal.timeout(10_000);
  const shellSchema = z.object({
    data: z.object({
      id: z.string(),
      status: z.enum(["running", "exited", "timeout", "killed"]),
      exit: z.number().int().optional(),
    }),
  });
  const createdShell = shellSchema.parse(
    await (
      await fetch(`${external.url}/api/shell`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          location: { directory: workspace },
          command: `${shellQuote(process.execPath)} ${shellQuote(credentialProbe)}`,
          timeout: 5_000,
        }),
        signal: probeSignal,
      })
    ).json(),
  );
  const shellURL = `${external.url}/api/shell/${encodeURIComponent(createdShell.data.id)}`;
  try {
    while (true) {
      const shell = shellSchema.parse(
        await (await fetch(shellURL, { headers, signal: probeSignal })).json(),
      );
      if (shell.data.status !== "running") {
        assert.equal(shell.data.status, "exited");
        assert.equal(shell.data.exit, 0);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const output = z
      .object({ data: z.object({ output: z.string() }) })
      .parse(
        await (
          await fetch(`${shellURL}/output`, { headers, signal: probeSignal })
        ).json(),
      );
    z.object({
      credentialPresent: z.literal(false),
      serviceStatus: z.literal(401),
    }).parse(JSON.parse(output.data.output.trim()));
    assert.equal(
      (
        await fetch(`${external.url}/api/info`, {
          headers,
          signal: probeSignal,
        })
      ).status,
      200,
      "owned client must retain authenticated access",
    );
    assert.equal(agentCalls, 2, "credential probe must make no model calls");
    console.log(
      "PASS native shell: no server password, unauthorized access, authenticated client preserved",
    );
  } finally {
    await fetch(shellURL, {
      method: "DELETE",
      headers,
      signal: AbortSignal.timeout(5_000),
    });
  }
  const url = new URL(external.url);
  const credential = Buffer.from(
    external.authorization.slice(6),
    "base64",
  ).toString("utf8");
  process.env.OPENCODE_SERVER_PASSWORD = credential.slice(
    credential.indexOf(":") + 1,
  );
  await run([
    "--opencode-v2-mode",
    "external",
    "--opencode-v2-host",
    "127.0.0.1",
    "--opencode-v2-port",
    url.port,
  ]);
  assert.equal(agentCalls, 4);
  await run(["--opencode-executable", executable], "opencode");
  await run(
    [
      "--opencode-mode",
      "external",
      "--opencode-host",
      "127.0.0.1",
      "--opencode-port",
      new URL(external.url).port,
    ],
    "opencode",
  );
  assert.equal(
    agentCalls,
    8,
    "automatic detection must execute each task once",
  );
  console.log(
    "PASS automatic CLI: managed and authenticated external V2 detection",
  );
  assert.equal(
    (await fetch(`${external.url}/api/info`, { headers })).status,
    200,
    "external service must survive CLI cleanup",
  );
  console.log(
    "PASS external CLI: typed output, reuse, authenticated service preserved",
  );
  const externalFlags = [
    "--opencode-v2-mode",
    "external",
    "--opencode-v2-host",
    "127.0.0.1",
    "--opencode-v2-port",
    url.port,
  ];
  async function expectFailure(message) {
    const before = agentCalls;
    let failure;
    try {
      await run(externalFlags);
    } catch (cause) {
      failure = cause;
    }
    const failed = z
      .object({ stdout: z.string(), code: z.literal(1) })
      .parse(failure);
    const value = z
      .object({
        status: z.literal("failed"),
        error: z.object({ message: z.string() }),
      })
      .parse(JSON.parse(failed.stdout));
    assert(
      value.error.message.includes(message),
      `Expected native failure containing ${JSON.stringify(message)}; received ${JSON.stringify(value.error.message)}`,
    );
    assert.equal(
      agentCalls,
      before + 1,
      "failure must not replay the task or execute its dependent",
    );
  }
  responseText = "invalid-json";
  await expectFailure("schema-valid JSON");
  responseText = '{"answer":"ok"}';
  console.log("PASS CLI malformed output: failed once, dependent skipped");
  questionMode = true;
  await expectFailure("requires human interaction");
  questionMode = false;
  console.log("PASS CLI native form: non-interactive failure, no task replay");
  shellMode = true;
  const controller = new AbortController();
  const runtime = await createOpenCodeV2AgentRuntimeFactory({
    adapter: "opencode-v2",
    url: external.url,
    authorization: external.authorization,
  })(controller.signal, workspace);
  const adapter = runtime.createAdapter({
    signal: controller.signal,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const response = await originalFetch(...args);
    if (
      new URL(String(args[0])).pathname === "/api/session" &&
      args[1]?.method === "POST" &&
      response.status === 200
    ) {
      const created = z
        .object({ data: z.object({ id: z.string() }) })
        .parse(await response.clone().json());
      rootObserved.resolve(created.data.id);
    }
    if (new URL(String(args[0])).pathname === "/api/shell") {
      const page = z
        .object({
          data: z.array(
            z.object({
              id: z.string(),
              status: z.string(),
              metadata: z.object({ sessionID: z.string() }).optional(),
            }),
          ),
        })
        .safeParse(await response.clone().json());
      if (
        page.success &&
        page.data.data.some(
          (shell) => shell.status === "running" && shell.metadata?.sessionID,
        )
      )
        shellObserved.resolve();
    }
    return response;
  };
  const signal = AbortSignal.timeout(15_000);
  let executionStarts = 0;
  const pending = adapter.execute({
    invocationId: "cancel-probe",
    task: {
      id: "cancel-probe",
      input: z.object({}),
      output: z.object({ answer: z.string() }),
      execute: async () => ({ answer: "unused" }),
    },
    input: {},
    agent: { goal: "Start one background command" },
    signal,
    onExecutionStarted() {
      executionStarts++;
    },
  });
  const rejected = pending.then(
    () => {
      throw new Error("Background work allowed premature success");
    },
    (cause) => cause,
  );
  try {
    await Promise.race([
      shellObserved.promise,
      new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      ),
    ]);
    const parentID = await rootObserved.promise;
    const created = z.object({ data: z.object({ id: z.string() }) }).parse(
      await (
        await originalFetch(`${external.url}/api/session`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            parentID,
            location: { directory: workspace },
            model: { providerID: "fixture", id: "fixture" },
          }),
          signal,
        })
      ).json(),
    );
    const childID = created.data.id;
    assert.equal(
      (
        await originalFetch(`${external.url}/api/session/${childID}/prompt`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ text: "Start a background command" }),
          signal,
        })
      ).status,
      200,
    );
    const shellPage = z.object({
      data: z.array(
        z.object({
          status: z.string(),
          metadata: z.object({ sessionID: z.string() }),
        }),
      ),
    });
    while (true) {
      const shells = shellPage.parse(
        await (
          await originalFetch(
            `${external.url}/api/shell?location%5Bdirectory%5D=${encodeURIComponent(workspace)}`,
            { headers, signal },
          )
        ).json(),
      );
      if (
        shells.data.some(
          (shell) =>
            shell.status === "running" && shell.metadata.sessionID === childID,
        )
      )
        break;
      signal.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    controller.abort();
    await rejected;
    assert.equal(executionStarts, 1);
    const shells = z
      .object({ data: z.array(z.object({ status: z.string() })) })
      .parse(
        await (
          await fetch(
            `${external.url}/api/shell?location%5Bdirectory%5D=${encodeURIComponent(workspace)}`,
            { headers },
          )
        ).json(),
      );
    assert(shells.data.every((shell) => shell.status !== "running"));
    assert.equal(toolCalls, 2);
    assert.equal(
      (await fetch(`${external.url}/api/session/${childID}`, { headers }))
        .status,
      404,
    );
    console.log(
      "PASS native parent/child shells: ownership, no premature success, cancellation, termination",
    );
  } finally {
    globalThis.fetch = originalFetch;
    await runtime.close();
  }
  console.log(
    `OpenCode client/server ${OPENCODE_V2_VERSION}: ${process.platform}/${process.arch}`,
  );
} finally {
  try {
    await external?.close();
  } finally {
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
    await rm(workflowDirectory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
}
