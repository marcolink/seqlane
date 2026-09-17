// @test-scope ./commands/run.ts
// @test-scope ./standalone-execution-preparation.ts
// @test-scope ./standalone-workflow.ts
// @test-scope ./standalone-adapter.ts
// @test-scope ./run-result.ts
// @test-scope ./event-dispatcher.ts
// @test-scope ./output.ts
// @test-scope ./commands/replay.ts
// @test-scope ./replay.ts
// @test-scope ./commands/studio.ts
// @test-scope ./commands/list.ts
// @test-scope ./commands/plan.ts
// @test-scope ./commands/serve.ts
// @test-scope ./cli-contracts.ts
// @test-scope ./command.ts
// @test-scope ../../../workflows/local-only-example/workflow.ts
// @test-scope ../../../workflows/until-example/workflow.ts

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  encodeSeqlaneExecutionEvent,
  type SeqlaneExecutionEvent,
} from "@seqlane/protocol";
import {
  planCommandResultSchema,
  workflowListResultSchema,
} from "./cli-contracts.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const productionEntry = fileURLToPath(
  new URL("../bin/run.js", import.meta.url),
);
const localWorkflowReference = "./workflows/local-only-example/workflow.ts";
const untilWorkflowReference = "./workflows/until-example/workflow.ts";

interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const nodeTypeStrippingWarning =
  /\(node:\d+\) ExperimentalWarning: Type Stripping is an experimental feature and might change at any time\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n?/g;

function runCli(
  args: readonly string[],
  options: {
    readonly input?: string;
    readonly onStarted?: (child: ChildProcess) => void;
    readonly startMarker?: string;
  } = {},
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(productionEntry, args, {
      cwd: repositoryRoot,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
    let stdout = "";
    let stderr = "";
    let started = false;
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (
        !started &&
        options.startMarker !== undefined &&
        stdout.includes(options.startMarker)
      ) {
        started = true;
        options.onStarted?.(child);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        code,
        stdout,
        stderr: stderr.replace(nodeTypeStrippingWarning, ""),
      }),
    );
  });
}

function createDiscoveryFixture(): {
  readonly directory: string;
  readonly repositoryRoot: string;
  readonly userRoot: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "seqlane-cli-discovery-"));
  const descriptorRepositoryRoot = join(directory, "repository");
  const descriptorUserRoot = join(directory, "user");
  mkdirSync(descriptorRepositoryRoot);
  mkdirSync(descriptorUserRoot);
  writeFileSync(
    join(descriptorRepositoryRoot, "minimal.json"),
    JSON.stringify({
      name: "discovered-minimal",
      moduleSpecifier: pathToFileURL(
        join(repositoryRoot, "workflows/minimal-example/workflow.ts"),
      ).href,
      exportName: "default",
      description: "A discovered minimal workflow",
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

function writeWorkflow(path: string, source: string): void {
  writeFileSync(path, source);
}

describe("seqlane CLI entrypoints", () => {
  it.each(["human", "json"] as const)(
    "runs built list in %s mode for a discovered descriptor",
    async (output) => {
      const fixture = createDiscoveryFixture();
      try {
        const result = await runCli(discoveryArgs("list", output, fixture));
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
        const result = await runCli(discoveryArgs("plan", output, fixture));
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
          expect(result.stdout).toContain("minimal-example-prepare");
        }
      } finally {
        rmSync(fixture.directory, { recursive: true, force: true });
      }
    },
  );

  it("starts and cleanly stops the built operational host", async () => {
    const fixture = createDiscoveryFixture();
    try {
      const result = await runCli(
        [
          "serve",
          "--port",
          "0",
          "--storage-url",
          "file::memory:",
          "--repository-root",
          fixture.repositoryRoot,
          "--user-root",
          fixture.userRoot,
        ],
        {
          startMarker: "Seqlane operational host:",
          onStarted: (child) => child.kill("SIGTERM"),
        },
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Seqlane operational host:");
      expect(result.stdout).toContain("Seqlane readiness:");
      expect(result.stderr).toBe("");
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("runs a deterministic TypeScript workflow through the installed entrypoint", async () => {
    const result = await runCli([
      "run",
      untilWorkflowReference,
      "--input",
      '{"remaining":3,"attempts":0}',
      "--json",
      "--workspace",
      repositoryRoot,
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "succeeded",
      output: { remaining: 0, attempts: 3, done: true },
    });
    expect(result.stderr).toBe("");
  });

  it("defaults omitted input to an empty object when the workflow accepts it", async () => {
    const directory = mkdtempSync(
      join(repositoryRoot, ".tmp-seqlane-empty-input-"),
    );
    const workflow = join(directory, "workflow.ts");
    writeWorkflow(
      workflow,
      `import { createFlow, defineTask } from "@seqlane/core";
import { z } from "zod";
const schema = z.object({});
const task = defineTask({ id: "empty-input", input: schema, output: schema, execute: async () => ({}) });
export default createFlow({ id: "empty-input", input: schema, output: schema }).task("task", task, () => ({})).output(({ tasks }) => tasks.task.output).define();
`,
    );
    try {
      const result = await runCli(["run", workflow, "--json"]);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: "succeeded",
        output: {},
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts workflow input from a file and stdin", async () => {
    const directory = mkdtempSync(join(tmpdir(), "seqlane-input-cli-"));
    const inputPath = join(directory, "input.json");
    writeFileSync(inputPath, '{"value":"from-file"}');
    try {
      const fileResult = await runCli([
        "run",
        localWorkflowReference,
        "--input-file",
        inputPath,
        "--json",
      ]);
      const stdinResult = await runCli(
        ["run", localWorkflowReference, "--input-file", "-", "--json"],
        { input: '{"value":"from-stdin"}' },
      );
      expect(fileResult.code).toBe(0);
      expect(JSON.parse(fileResult.stdout)).toMatchObject({
        output: { value: "from-file" },
      });
      expect(stdinResult.code).toBe(0);
      expect(JSON.parse(stdinResult.stdout)).toMatchObject({
        output: { value: "from-stdin" },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("prints a calculated Plan without executing a standalone workflow", async () => {
    const result = await runCli([
      "run",
      localWorkflowReference,
      "--input",
      '{"value":"local"}',
      "--dry",
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      workflow: { id: "local-only-example" },
      nodes: [expect.objectContaining({ taskId: "local-only-example-task" })],
    });
    expect(result.stderr).toBe("");
  });

  it.each([
    ["--runtime", "http://127.0.0.1:1234"],
    ["--host", "http://127.0.0.1:1234"],
    ["--record", "run.jsonl"],
    ["repository:discovered-workflow"],
  ])("rejects retired standalone run input %j", async (retired) => {
    const args =
      retired[0] === "repository:discovered-workflow"
        ? ["run", retired[0], "--dry"]
        : ["run", localWorkflowReference, "--dry", ...retired];
    const result = await runCli(args);
    expect(result.code).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(
      /unknown flag|local file or installed package/i,
    );
  });

  it("requires an adapter for an agent workflow", async () => {
    const result = await runCli([
      "run",
      "./workflows/minimal-example/workflow.ts",
      "--input",
      '{"topic":"Seqlane"}',
      "--json",
    ]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "failed",
      phase: "execution",
    });
  });

  it("rejects an unknown adapter before loading the workflow", async () => {
    const result = await runCli([
      "run",
      "./missing-workflow.ts",
      "--adapter",
      "unknown",
      "--json",
    ]);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "failed",
      phase: "command",
      error: {
        message: 'Unknown adapter "unknown"; supported adapters: opencode',
      },
    });
    expect(result.stderr).not.toContain("missing-workflow");
  });

  it("keeps workflow output out of JSON stdout", async () => {
    const directory = mkdtempSync(
      join(repositoryRoot, ".tmp-seqlane-cli-json-output-"),
    );
    const workflow = join(directory, "workflow.ts");
    writeWorkflow(
      workflow,
      `import { createFlow, defineTask } from "@seqlane/core";
import { z } from "zod";
console.log("import output");
const schema = z.object({});
const task = defineTask({ id: "output", input: schema, output: schema, execute: () => { console.log("task output"); return {}; } });
export default createFlow({ id: "json-output", input: schema, output: schema }).task("output", task, () => ({})).output(({ tasks }) => tasks.output.output).define();
`,
    );
    try {
      const result = await runCli(["run", workflow, "--json"]);
      expect(result.code, JSON.stringify(result)).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: "succeeded" });
      expect(result.stderr).toContain("import output");
      expect(result.stderr).toContain("task output");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports an unserializable success output as result serialization failure", async () => {
    const directory = mkdtempSync(
      join(repositoryRoot, ".tmp-seqlane-cli-result-output-"),
    );
    const workflow = join(directory, "workflow.ts");
    writeWorkflow(
      workflow,
      `import { createFlow, defineTask } from "@seqlane/core";
import { z } from "zod";
const input = z.object({});
const output = z.any();
const task = defineTask({ id: "non-json", input, output, execute: () => Number.NaN });
export default createFlow({ id: "non-json-output", input, output }).task("non-json", task, () => ({})).output(({ tasks }) => tasks["non-json"].output).define();
`,
    );
    try {
      const result = await runCli(["run", workflow, "--json"]);
      expect(result.code, JSON.stringify(result)).toBe(1);
      expect(JSON.parse(result.stdout), JSON.stringify(result)).toMatchObject({
        status: "failed",
        phase: "result-serialization",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "returns a cancellation result after %s for a deterministic held task",
    async (signal) => {
      const directory = mkdtempSync(join(repositoryRoot, ".tmp-seqlane-hold-"));
      const workflow = join(directory, "workflow.ts");
      writeWorkflow(
        workflow,
        `import { createFlow, defineTask } from "@seqlane/core";
import { z } from "zod";
const schema = z.object({});
const task = defineTask({ id: "hold", input: schema, output: schema, execute: async ({ signal }) => await new Promise((resolve) => signal.addEventListener("abort", () => resolve({}), { once: true })) });
export default createFlow({ id: "hold", input: schema, output: schema }).task("hold", task, () => ({})).output(({ tasks }) => tasks.hold.output).define();
`,
      );
      try {
        const result = await runCli(["run", workflow, "--output", "ci"], {
          startMarker: "started task=hold",
          onStarted: (child) => child.kill(signal),
        });
        expect(result.code, JSON.stringify(result)).toBe(130);
        expect(result.stdout).toContain("cancelled");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

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
      const result = await runCli(["replay", path, "--events", "ndjson"]);
      expect(result.code).toBe(0);
      expect(
        result.stdout
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line).type),
      ).toEqual(["run.started", "run.plan"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("prints one concise contextual error for a malformed recording", async () => {
    const directory = mkdtempSync(join(tmpdir(), "seqlane-replay-error-cli-"));
    const path = join(directory, "invalid.jsonl");
    writeFileSync(path, "not-json\n");
    try {
      const result = await runCli(["replay", path, "--output", "human"]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Could not read recording:");
      expect(result.stderr).toContain("Invalid recording header JSON");
      expect(result.stderr).not.toContain("Caused by:");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
