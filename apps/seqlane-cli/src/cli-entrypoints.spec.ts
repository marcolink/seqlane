// @test-scope ./commands/run.ts
// @test-scope ./commands/replay.ts
// @test-scope ./runner-client.ts
// @test-scope ./event-dispatcher.ts
// @test-scope ./output.ts
// @test-scope ./recording.ts
// @test-scope ./commands/studio.ts
// @test-scope ../../../examples/minimal-workflow.ts

import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  encodeSeqlaneExecutionEvent,
  type SeqlaneExecutionEvent,
} from "@seqlane/events";

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

function runCli(
  entry: string,
  args: readonly string[],
  onStarted?: (child: ChildProcess) => void,
  startMarker = "created label=investigate-renovate-failure",
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(entry, args, {
      cwd: repositoryRoot,
      env: { ...process.env, FORCE_COLOR: "0" },
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
) {
  const requests: string[] = [];
  const pendingPrompts: ServerResponse[] = [];
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

  return { requests, server, url: `http://127.0.0.1:${address.port}` };
}

async function closeFakeOpenCodeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  server.close();
  await once(server, "close");
}

describe("seqlane CLI entrypoints", () => {
  it("runs compiled commands through the installed entrypoint", async () => {
    const fake = await startFakeOpenCodeServer("success");
    try {
      const result = await runCli(
        productionEntry,
        runArgs(input, workflowReference, fake.url),
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/run=.* succeeded/);
    } finally {
      await closeFakeOpenCodeServer(fake.server);
    }
  });

  it("keeps explicit JSON output machine-readable at the CLI boundary", async () => {
    const fake = await startFakeOpenCodeServer("success", "example");
    try {
      const result = await runCli(
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
      expect(result.stderr).toContain(
        `Seqlane session UI: ${fake.url}/${Buffer.from(repositoryRoot, "utf8").toString("base64url")}/session/session-1`,
      );
    } finally {
      await closeFakeOpenCodeServer(fake.server);
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

  it("requires a runtime when not in dry-run mode", async () => {
    const result = await runCli(productionEntry, [
      "run",
      exampleWorkflowReference,
      "--input",
      builtinInput,
    ]);

    expect(result.code).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toMatch(/runtime/i);
  });

  it("runs a TypeScript workflow file through its default export", async () => {
    const fake = await startFakeOpenCodeServer("success", "example");
    try {
      const result = await runCli(
        productionEntry,
        runArgs(builtinInput, exampleWorkflowReference, fake.url, "json"),
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('"type":"run.succeeded"');
    } finally {
      await closeFakeOpenCodeServer(fake.server);
    }
  });

  it("records canonical events to a new file and warns on stderr", async () => {
    const fake = await startFakeOpenCodeServer("success", "example");
    const directory = mkdtempSync(join(tmpdir(), "seqlane-recording-cli-"));
    const path = join(directory, "run.jsonl");
    try {
      const result = await runCli(productionEntry, [
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
      await closeFakeOpenCodeServer(fake.server);
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
    const result = await runCli(
      productionEntry,
      runArgs(input, workflowReference, fake.url),
    );
    await closeFakeOpenCodeServer(fake.server);

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
      const result = await runCli(
        developmentEntry,
        runArgs(input, workflowReference, fake.url),
        (child) => child.kill("SIGINT"),
      );

      expect(result.code).toBe(130);
      expect(result.stdout).toContain("cancelled");
      expect(
        fake.requests.filter((path) => path.endsWith("/abort")),
      ).toHaveLength(1);
      expect(
        fake.requests.some((path) =>
          /permission\/.*\/reply|question|tui|reply/i.test(path),
        ),
      ).toBe(false);
    } finally {
      await closeFakeOpenCodeServer(fake.server);
    }
  });

  it("rejects invalid input before starting a runner", async () => {
    const result = await runCli(productionEntry, runArgs("{"));

    expect(result.code).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/input|JSON/i);
    expect(result.stdout).not.toContain("workflow started");
  });

  it("starts Studio replay from the explicit recording flag", async () => {
    const directory = mkdtempSync(join(tmpdir(), "seqlane-studio-replay-cli-"));
    const path = join(directory, "private-recording.jsonl");
    const event: SeqlaneExecutionEvent = {
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
    writeFileSync(
      path,
      `${JSON.stringify({ type: "seqlane.recording", version: 1, workflowId: "workflow-1" })}\n${encodeSeqlaneExecutionEvent(event)}\n`,
    );
    try {
      const result = await runCli(
        productionEntry,
        ["studio", "--replay", path],
        (child) => child.kill("SIGINT"),
        "Seqlane Studio:",
      );

      expect(result.code).toBe(0);
      const match = result.stdout.match(/Seqlane Studio: (\S+)/);
      expect(match).not.toBeNull();
      const browserUrl = new URL(match?.[1] ?? "");
      expect(browserUrl.searchParams.get("replay")).toMatch(/^[0-9a-f-]{36}$/);
      expect(browserUrl.searchParams.get("debug")).toBe("1");
      expect(result.stdout).not.toContain(path);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
