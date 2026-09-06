// @test-scope ./commands/run.ts
// @test-scope ./commands/replay.ts
// @test-scope ./runner-client.ts
// @test-scope ./event-dispatcher.ts
// @test-scope ./output.ts
// @test-scope ./recording.ts
// @test-scope ./commands/studio.ts
// @test-scope ./commands/list.ts
// @test-scope ./commands/plan.ts
// @test-scope ./cli-contracts.ts
// @test-scope ../../../examples/minimal-workflow.ts
// @test-scope ../../../examples/local-only.ts

import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  encodeSeqlaneExecutionEvent,
  seqlaneExecutionEventSchema,
  type SeqlaneExecutionEvent,
} from "@seqlane/events";
import {
  planCommandResultSchema,
  workflowListResultSchema,
} from "./cli-contracts.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const developmentEntry = fileURLToPath(
  new URL("../bin/dev.js", import.meta.url),
);
const productionEntry = fileURLToPath(
  new URL("../bin/run.js", import.meta.url),
);
const workflowReference =
  "@seqlane/fixtures/renovate-workflow#renovateWorkflow";
const exampleWorkflowReference = "examples/minimal-workflow.ts";
const localOnlyWorkflowReference = "examples/local-only.ts";
const input = JSON.stringify({
  dependency: "some-package",
  fromVersion: "1.0.0",
  toVersion: "2.0.0",
  failure: "Tests fail after update",
});
const builtinInput = JSON.stringify({ topic: "Seqlane" });

interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface FakeOpenCodeServer {
  readonly requests: string[];
  readonly server: Server;
  readonly url: string;
  readonly acpDirectory: string;
  readonly acpEventsPath: string;
  readonly acpMode: "success" | "interaction" | "hold";
  readonly acpWorkflow: "renovate" | "example";
}

const fakeAcpAgent = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");

const mode = process.env.SEQLANE_FAKE_ACP_MODE;
const workflow = process.env.SEQLANE_FAKE_ACP_WORKFLOW;
const eventsPath = process.env.SEQLANE_FAKE_ACP_EVENTS;
let pendingPrompt;
let pendingPermissionId;

function record(method) {
  fs.appendFileSync(eventsPath, JSON.stringify({ method }) + "\n");
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function outputForPrompt(prompt) {
  if (workflow === "example") {
    return prompt.includes("Polish this draft")
      ? { answer: "A polished Seqlane answer." }
      : { draft: "A short Seqlane draft." };
  }
  if (prompt.includes("Create a remediation")) {
    return {
      steps: ["update peer range", "refresh lockfile"],
      summary: "Apply the dependency and lockfile remediation",
    };
  }
  if (prompt.includes("Apply the Renovate")) {
    return {
      changedFiles: ["package.json", "pnpm-lock.yaml"],
      summary: "Dependency update and lockfile repaired",
    };
  }
  if (prompt.includes("Verify the Renovate")) {
    return { passed: true, summary: "Install and targeted tests pass" };
  }
  return {
    files: ["package.json", "pnpm-lock.yaml"],
    rootCause: "Renovate updated a dependency without its peer range",
  };
}

function completePrompt(request) {
  const text = JSON.stringify(outputForPrompt(request.params.prompt[0].text));
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "acp-session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  });
  respond(request.id, { stopReason: "end_turn" });
}

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);

  if (pendingPermissionId !== undefined && message.id === pendingPermissionId) {
    pendingPermissionId = undefined;
    if (pendingPrompt !== undefined) {
      const request = pendingPrompt;
      pendingPrompt = undefined;
      completePrompt(request);
    }
    return;
  }

  if (message.method === "session/cancel") {
    record(message.method);
    if (pendingPrompt !== undefined) {
      const request = pendingPrompt;
      pendingPrompt = undefined;
      respond(request.id, { stopReason: "cancelled" });
    }
    return;
  }

  if (typeof message.method !== "string") return;
  record(message.method);

  switch (message.method) {
    case "initialize":
      respond(message.id, {
        protocolVersion: 1,
        agentInfo: { name: "fake-opencode", version: "1.0.0" },
        agentCapabilities: {},
      });
      break;
    case "session/new":
      respond(message.id, {
        sessionId: "acp-session-1",
        models: {
          availableModels: [
            { modelId: "openai/gpt-5.6-luna", name: "Fake Luna" },
            { modelId: "openai/gpt-5.6-terra", name: "Fake Terra" },
          ],
          currentModelId: "openai/gpt-5.6-luna",
        },
      });
      break;
    case "session/set_model":
      respond(message.id, {});
      break;
    case "session/prompt":
      if (mode === "hold") {
        pendingPrompt = message;
      } else if (mode === "interaction") {
        pendingPrompt = message;
        pendingPermissionId = 100;
        send({
          jsonrpc: "2.0",
          id: pendingPermissionId,
          method: "session/request_permission",
          params: {
            sessionId: "acp-session-1",
            toolCall: {
              toolCallId: "fake-tool",
              title: "Private approval",
              kind: "execute",
              status: "in_progress",
            },
            options: [
              { optionId: "allow", name: "Allow", kind: "allow_once" },
            ],
          },
        });
      } else {
        completePrompt(message);
      }
      break;
  }
});
`;

function runCli(
  entry: string,
  args: readonly string[],
  onStarted?: (child: ChildProcess) => void,
  startMarker = "started task=investigate-renovate-failure",
  environment: NodeJS.ProcessEnv = {},
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(entry, args, {
      cwd: repositoryRoot,
      env: { ...process.env, FORCE_COLOR: "0", ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let signalSent = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (!signalSent && stdout.includes(startMarker)) {
        signalSent = true;
        onStarted?.(child);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function runArgs(
  inputValue = input,
  workflow = workflowReference,
  runtime = "http://127.0.0.1:1234",
  output = "ci",
): string[] {
  return [
    "run",
    workflow,
    "--input",
    inputValue,
    "--runtime",
    runtime,
    "--workspace",
    repositoryRoot,
    "--output",
    output,
  ];
}

function writeJson(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function startFakeOpenCodeServer(
  mode: "success" | "interaction" | "hold",
  workflow: "renovate" | "example" = "renovate",
): Promise<FakeOpenCodeServer> {
  const requests: string[] = [];
  const pendingPrompts: ServerResponse[] = [];
  const acpDirectory = mkdtempSync(join(tmpdir(), "seqlane-acp-agent-"));
  const acpEventsPath = join(acpDirectory, "events.jsonl");
  const acpPath = join(acpDirectory, "opencode");
  writeFileSync(acpPath, fakeAcpAgent, { mode: 0o755 });
  writeFileSync(acpEventsPath, "");
  let promptCount = 0;
  const server = createServer(async (request, response) => {
    request.on("aborted", () => response.end());
    for await (const chunk of request) void chunk;
    const requestUrl = request.url ?? "/";
    const path = new URL(requestUrl, "http://127.0.0.1").pathname;
    requests.push(path);

    if (request.method === "GET" && path === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end();
      return;
    }

    if (request.method === "GET" && path === "/provider") {
      writeJson(response, {
        all: [
          {
            id: "openai",
            models: {
              "gpt-5.6-luna": { id: "gpt-5.6-luna" },
              "gpt-5.6-terra": { id: "gpt-5.6-terra" },
            },
          },
          {
            id: "fake-provider",
            models: { "fake-model": { id: "fake-model" } },
          },
        ],
        default: { openai: "gpt-5.6-luna" },
        connected: ["openai", "fake-provider"],
      });
      return;
    }

    if (request.method === "GET" && path === "/config/providers") {
      writeJson(response, {
        providers: [
          {
            id: "openai",
            models: {
              "gpt-5.6-luna": { id: "gpt-5.6-luna" },
              "gpt-5.6-terra": { id: "gpt-5.6-terra" },
            },
          },
          {
            id: "fake-provider",
            models: { "fake-model": { id: "fake-model" } },
          },
        ],
        default: { openai: "gpt-5.6-luna" },
      });
      return;
    }

    if (request.method === "POST" && path === "/session") {
      writeJson(response, {
        id: "session-1",
        projectID: "project-1",
        directory: repositoryRoot,
        title: "Seqlane CLI",
        version: "1",
        time: { created: 1, updated: 1 },
      });
      return;
    }

    if (request.method === "POST" && path === "/session/session-1/message") {
      if (mode === "hold") {
        pendingPrompts.push(response);
        setTimeout(() => {
          if (!response.writableEnded) {
            writeJson(response, {
              info: {
                error: {
                  name: "MessageAbortedError",
                  data: { message: "test timeout" },
                },
              },
              parts: [],
            });
          }
        }, 1_000);
        return;
      }
      if (mode === "interaction") {
        writeJson(response, {
          info: {
            id: "message-1",
            sessionID: "session-1",
            role: "assistant",
            time: { created: 1, completed: 2 },
            parentID: "message-0",
            modelID: "fake-model",
            providerID: "fake-provider",
            mode: "build",
            agent: "build",
            path: { cwd: repositoryRoot, root: repositoryRoot },
            cost: 0,
            tokens: {
              total: 0,
              input: 0,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            error: {
              name: "PermissionRequired",
              data: { prompt: "private approval request" },
            },
          },
          parts: [],
        });
        return;
      }

      promptCount += 1;
      const structured =
        workflow === "example"
          ? [
              { draft: "A short Seqlane draft." },
              { answer: "A polished Seqlane answer." },
            ][promptCount - 1]
          : [
              {
                files: ["package.json", "pnpm-lock.yaml"],
                rootCause:
                  "Renovate updated a dependency without its peer range",
              },
              {
                steps: ["update peer range", "refresh lockfile"],
                summary: "Apply the dependency and lockfile remediation",
              },
              {
                changedFiles: ["package.json", "pnpm-lock.yaml"],
                summary: "Dependency update and lockfile repaired",
              },
              { passed: true, summary: "Install and targeted tests pass" },
            ][promptCount - 1];
      writeJson(response, {
        info: {
          structured,
          id: `message-${promptCount}`,
          sessionID: "session-1",
          role: "assistant",
          time: { created: promptCount, completed: promptCount + 1 },
          parentID: "message-0",
          modelID: "fake-model",
          providerID: "fake-provider",
          mode: "build",
          agent: "build",
          path: { cwd: repositoryRoot, root: repositoryRoot },
          cost: 0,
          tokens: {
            total: 0,
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
        parts: [],
      });
      return;
    }

    if (request.method === "GET" && path === "/event") {
      response.writeHead(200, {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream",
      });
      return;
    }

    if (request.method === "GET" && path === "/permission") {
      writeJson(response, []);
      return;
    }

    if (request.method === "POST" && path === "/session/session-1/abort") {
      for (const pending of pendingPrompts.splice(0)) {
        writeJson(pending, {
          info: {
            error: {
              name: "MessageAbortedError",
              data: { message: "aborted" },
            },
          },
          parts: [],
        });
      }
      writeJson(response, true);
      return;
    }

    response.writeHead(404);
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Fake OpenCode server did not expose a TCP address");
  }

  return {
    requests,
    server,
    url: `http://127.0.0.1:${address.port}`,
    acpDirectory,
    acpEventsPath,
    acpMode: mode,
    acpWorkflow: workflow,
  };
}

async function closeFakeOpenCodeServer(
  fake: FakeOpenCodeServer,
): Promise<void> {
  fake.server.closeAllConnections();
  fake.server.close();
  await once(fake.server, "close");
  rmSync(fake.acpDirectory, { recursive: true, force: true });
}

function fakeAcpEnvironment(
  fake: FakeOpenCodeServer,
  mode: "success" | "interaction" | "hold",
  workflow: "renovate" | "example" = "renovate",
): NodeJS.ProcessEnv {
  const pathSeparator = process.platform === "win32" ? ";" : ":";
  return {
    PATH: `${fake.acpDirectory}${pathSeparator}${process.env.PATH ?? ""}`,
    SEQLANE_FAKE_ACP_MODE: mode,
    SEQLANE_FAKE_ACP_WORKFLOW: workflow,
    SEQLANE_FAKE_ACP_EVENTS: fake.acpEventsPath,
  };
}

function runFakeCli(
  fake: FakeOpenCodeServer,
  entry: string,
  args: readonly string[],
  onStarted?: (child: ChildProcess) => void,
): Promise<CliResult> {
  return runCli(
    entry,
    args,
    onStarted,
    undefined,
    fakeAcpEnvironment(fake, fake.acpMode, fake.acpWorkflow),
  );
}

describe("seqlane CLI entrypoints", () => {
  function createDiscoveryFixture(
    workflow: "minimal" | "local-only" = "minimal",
  ): {
    readonly directory: string;
    readonly repositoryRoot: string;
    readonly userRoot: string;
  } {
    const directory = mkdtempSync(join(tmpdir(), "seqlane-cli-discovery-"));
    const descriptorRepositoryRoot = join(directory, "repository");
    const descriptorUserRoot = join(directory, "user");
    mkdirSync(descriptorRepositoryRoot);
    mkdirSync(descriptorUserRoot);
    const discoveredWorkflow =
      workflow === "local-only"
        ? {
            name: "discovered-local-only",
            modulePath: join(repositoryRoot, "examples/local-only.ts"),
            description: "A discovered local-only workflow",
          }
        : {
            name: "discovered-minimal",
            modulePath: join(repositoryRoot, "examples/minimal-workflow.ts"),
            description: "A discovered minimal workflow",
          };
    writeFileSync(
      join(descriptorRepositoryRoot, "minimal.json"),
      JSON.stringify({
        name: discoveredWorkflow.name,
        moduleSpecifier: pathToFileURL(discoveredWorkflow.modulePath).href,
        exportName: "default",
        description: discoveredWorkflow.description,
      }),
    );
    return {
      directory,
      repositoryRoot: descriptorRepositoryRoot,
      userRoot: descriptorUserRoot,
    };
  }

  function discoveryArgs(
    command: "list" | "plan",
    output: "human" | "json",
    fixture: { readonly repositoryRoot: string; readonly userRoot: string },
  ): string[] {
    return [
      command,
      ...(command === "plan" ? ["discovered-minimal"] : []),
      "--output",
      output,
      "--repository-root",
      fixture.repositoryRoot,
      "--user-root",
      fixture.userRoot,
    ];
  }

  it.each(["human", "json"] as const)(
    "runs built list in %s mode for a discovered descriptor",
    async (output) => {
      const fixture = createDiscoveryFixture();
      try {
        const result = await runCli(
          productionEntry,
          discoveryArgs("list", output, fixture),
        );

        expect(result.code).toBe(0);
        if (output === "json") {
          expect(
            workflowListResultSchema.parse(JSON.parse(result.stdout)),
          ).toEqual([
            expect.objectContaining({
              qualifiedName: "repository:discovered-minimal",
              description: "A discovered minimal workflow",
            }),
          ]);
        } else {
          expect(result.stdout).toContain("repository:discovered-minimal");
          expect(result.stdout).toContain("A discovered minimal workflow");
        }
      } finally {
        rmSync(fixture.directory, { recursive: true, force: true });
      }
    },
  );

  it.each(["human", "json"] as const)(
    "runs built plan in %s mode for a discovered descriptor",
    async (output) => {
      const fixture = createDiscoveryFixture();
      try {
        const result = await runCli(
          productionEntry,
          discoveryArgs("plan", output, fixture),
        );

        expect(result.code).toBe(0);
        if (output === "json") {
          const plan = planCommandResultSchema.parse(JSON.parse(result.stdout));
          expect(plan.workflow.qualifiedName).toBe(
            "repository:discovered-minimal",
          );
          expect(plan.plan.workflow.id).toBe("minimal-example");
        } else {
          expect(result.stdout).toContain(
            "Plan for repository:discovered-minimal",
          );
          expect(result.stdout).toContain("example.prepare");
        }
      } finally {
        rmSync(fixture.directory, { recursive: true, force: true });
      }
    },
  );

  it("runs compiled commands through the installed entrypoint", async () => {
    const fake = await startFakeOpenCodeServer("success");
    try {
      const result = await runFakeCli(
        fake,
        productionEntry,
        runArgs(input, workflowReference, fake.url),
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/run=.* succeeded/);
    } finally {
      await closeFakeOpenCodeServer(fake);
    }
  });

  it("runs a discovered local-only workflow through the installed entrypoint", async () => {
    const fixture = createDiscoveryFixture("local-only");
    try {
      const result = await runCli(productionEntry, [
        "run",
        "repository:discovered-local-only",
        "--input",
        '{"value":"local"}',
        "--output",
        "json",
        "--repository-root",
        fixture.repositoryRoot,
        "--user-root",
        fixture.userRoot,
      ]);

      expect(result.code).toBe(0);
      const events = result.stdout
        .trimEnd()
        .split("\n")
        .map((line) => seqlaneExecutionEventSchema.parse(JSON.parse(line)));
      const planEvent = events.find((event) => event.type === "run.plan");
      if (planEvent?.type !== "run.plan") {
        throw new Error("Discovered local-only run did not emit a Plan event");
      }

      expect(planEvent.plan.nodes).toEqual([
        expect.objectContaining({
          execution: "local",
        }),
      ]);
      expect(
        planEvent.plan.nodes.every((node) => node.session === undefined),
      ).toBe(true);
      expect(events.at(-1)?.type).toBe("run.succeeded");
      expect(result.stderr).toBe("");
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("keeps explicit JSON output machine-readable at the CLI boundary", async () => {
    const fake = await startFakeOpenCodeServer("success", "example");
    try {
      const result = await runFakeCli(
        fake,
        productionEntry,
        runArgs(builtinInput, exampleWorkflowReference, fake.url, "json"),
      );

      expect(result.code).toBe(0);
      const records = result.stdout
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string });
      expect(records.at(-1)?.type).toBe("run.succeeded");
      expect(result.stdout).not.toContain("run=run-");
      expect(result.stderr).toContain(`Seqlane session UI: ${fake.url}`);
    } finally {
      await closeFakeOpenCodeServer(fake);
    }
  });

  it("prints the calculated Plan without contacting the runtime in dry-run mode", async () => {
    const result = await runCli(productionEntry, [
      "run",
      exampleWorkflowReference,
      "--input",
      builtinInput,
      "--dry",
    ]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      workflow: { id: "minimal-example" },
      nodes: [
        {
          planNodeId: "example.prepare:1",
          type: "task",
          taskId: "example.prepare",
          session: {
            type: "isolated",
            model: {
              model: { provider: "openai", model: "gpt-5.6-luna" },
              reasoning: "high",
            },
          },
        },
        {
          planNodeId: "validation.check:1",
          type: "validation.check",
        },
        {
          planNodeId: "validation.gate:1",
          type: "validation.gate",
        },
        {
          planNodeId: "example.finish:1",
          type: "task",
          taskId: "example.finish",
        },
      ],
    });
    expect(result.stderr).toBe("");
  });

  it("fails an agent workflow without a runtime profile", async () => {
    const result = await runCli(productionEntry, [
      "run",
      exampleWorkflowReference,
      "--input",
      builtinInput,
    ]);

    expect(result.code).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toMatch(
      /runtime profile.*not configured/i,
    );
  });

  it("runs a local-only workflow without a runtime profile", async () => {
    const result = await runCli(productionEntry, [
      "run",
      localOnlyWorkflowReference,
      "--input",
      '{"value":"local"}',
      "--output",
      "json",
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('"type":"run.succeeded"');
  });

  it("runs a TypeScript workflow file through its default export", async () => {
    const fake = await startFakeOpenCodeServer("success", "example");
    try {
      const result = await runFakeCli(
        fake,
        productionEntry,
        runArgs(builtinInput, exampleWorkflowReference, fake.url, "json"),
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('"type":"run.succeeded"');
    } finally {
      await closeFakeOpenCodeServer(fake);
    }
  });

  it("records canonical events to a new file and warns on stderr", async () => {
    const fake = await startFakeOpenCodeServer("success", "example");
    const directory = mkdtempSync(join(tmpdir(), "seqlane-recording-cli-"));
    const path = join(directory, "run.jsonl");
    try {
      const result = await runFakeCli(fake, productionEntry, [
        ...runArgs(builtinInput, exampleWorkflowReference, fake.url, "ci"),
        "--record",
        path,
      ]);

      expect(result.code).toBe(0);
      expect(result.stderr).toContain("execution data is written to disk");
      const lines = readFileSync(path, "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as { type?: string });
      expect(lines[0]).toMatchObject({
        type: "seqlane.recording",
        workflowId: exampleWorkflowReference,
      });
      expect(lines.map((line) => line.type)).toContain("run.plan");
    } finally {
      await closeFakeOpenCodeServer(fake);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("replays a plan prefix without starting a runner", async () => {
    const directory = mkdtempSync(join(tmpdir(), "seqlane-replay-cli-"));
    const path = join(directory, "prefix.jsonl");
    const started: SeqlaneExecutionEvent = {
      type: "run.started",
      metadata: {
        schemaVersion: 1,
        eventId: "event-1",
        sequence: 1,
        occurredAt: "2026-08-22T12:00:00.000Z",
      },
      workId: "work-1",
      runId: "run-1",
    };
    const plan: SeqlaneExecutionEvent = {
      type: "run.plan",
      metadata: {
        schemaVersion: 1,
        eventId: "event-2",
        sequence: 2,
        occurredAt: "2026-08-22T12:00:00.001Z",
      },
      workId: "work-1",
      runId: "run-1",
      plan: {
        workflow: { id: "workflow-1" },
        nodes: [
          {
            planNodeId: "task:one",
            type: "task",
            label: "One",
            dependsOn: [],
            siblingOrder: 0,
          },
        ],
      },
    };
    writeFileSync(
      path,
      `${JSON.stringify({ type: "seqlane.recording", version: 1, workflowId: "workflow-1" })}\n${encodeSeqlaneExecutionEvent(started)}\n${encodeSeqlaneExecutionEvent(plan)}\n`,
    );
    try {
      const result = await runCli(productionEntry, [
        "replay",
        path,
        "--output",
        "json",
      ]);

      expect(result.code).toBe(0);
      const eventTypes = result.stdout
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string })
        .map((event) => event.type);
      expect(eventTypes).toEqual(["run.started", "run.plan"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("renders interaction failure and returns status 1", async () => {
    const fake = await startFakeOpenCodeServer("interaction");
    const result = await runFakeCli(
      fake,
      productionEntry,
      runArgs(input, workflowReference, fake.url),
    );
    await closeFakeOpenCodeServer(fake);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain(
      "Seqlane execution requires human interaction",
    );
    expect(result.stdout).not.toContain("rawRequest");
    expect(result.stdout).not.toContain("cancelled");
  });

  it("forwards cancellation and sends only the runner cancel control", async () => {
    const fake = await startFakeOpenCodeServer("hold");
    try {
      const result = await runFakeCli(
        fake,
        developmentEntry,
        runArgs(input, workflowReference, fake.url),
        (child) => child.kill("SIGINT"),
      );

      expect(result.code).toBe(130);
      expect(result.stdout).toContain("cancelled");
      const acpMethods = readFileSync(fake.acpEventsPath, "utf8")
        .trimEnd()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { method: string })
        .map(({ method }) => method);
      expect(
        acpMethods.filter((method) => method === "session/cancel"),
      ).toHaveLength(1);
      expect(
        fake.requests.some((path) =>
          /permission\/.*\/reply|question|tui|reply/i.test(path),
        ),
      ).toBe(false);
    } finally {
      await closeFakeOpenCodeServer(fake);
    }
  });

  it("rejects invalid input before starting a runner", async () => {
    const result = await runCli(productionEntry, runArgs("{"));

    expect(result.code).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/input|JSON/i);
    expect(result.stdout).not.toContain("workflow started");
  });
});
