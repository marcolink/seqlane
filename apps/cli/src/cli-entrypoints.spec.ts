// @test-scope ./commands/run.ts
// @test-scope ./run-operational-host.ts
// @test-scope ./run-result.ts
// @test-scope ./run-lifecycle.ts
// @test-scope ./commands/replay.ts
// @test-scope ./replay.ts
// @test-scope ./runner-client.ts
// @test-scope ./event-dispatcher.ts
// @test-scope ./output.ts
// @test-scope ./recording.ts
// @test-scope ./commands/studio.ts
// @test-scope ./commands/list.ts
// @test-scope ./commands/plan.ts
// @test-scope ./commands/serve.ts
// @test-scope ./cli-contracts.ts
// @test-scope ./command.ts
// @test-scope ../../../workflows/minimal-example/workflow.ts
// @test-scope ../../../workflows/local-only-example/workflow.ts
// @test-scope ../../../workflows/until-example/workflow.ts

import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import { createServer } from "node:http";
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
const developmentEntry = fileURLToPath(
  new URL("../bin/dev.js", import.meta.url),
);
const workflowReference =
  "@seqlane/fixtures/renovate-workflow#renovateWorkflow";
const exampleWorkflowReference = "workflows/minimal-example/workflow.ts";
const localOnlyWorkflowReference = "workflows/local-only-example/workflow.ts";
const untilWorkflowReference = "workflows/until-example/workflow.ts";
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

const nodeTypeStrippingWarning =
  /\(node:\d+\) ExperimentalWarning: Type Stripping is an experimental feature and might change at any time\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n?/g;

function withoutNodeExperimentalWarnings(stderr: string): string {
  return stderr.replace(nodeTypeStrippingWarning, "");
}

interface RunCliOptions {
  readonly onStarted?: (child: ChildProcess) => void;
  readonly startMarker?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly onSpawn?: (child: ChildProcess) => void;
  readonly stdin?: string;
}

function runCli(
  entry: string,
  args: readonly string[],
  {
    onStarted,
    startMarker = "started task=investigate-renovate-failure",
    environment = {},
    onSpawn,
    stdin,
  }: RunCliOptions = {},
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(entry, args, {
      cwd: repositoryRoot,
      env: { ...process.env, FORCE_COLOR: "0", ...environment },
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    onSpawn?.(child);
    if (stdin !== undefined) child.stdin?.end(stdin);
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
    child.on("close", (code) =>
      resolve({
        code,
        stdout,
        stderr: withoutNodeExperimentalWarnings(stderr),
      }),
    );
  });
}

function expectNoSeqlaneDiagnostics(stderr: string): void {
  expect(stderr).not.toMatch(/\bseqlane\b/i);
}

function runArgs(
  inputValue = input,
  workflow = workflowReference,
  output = "ci",
): string[] {
  const args = [
    "run",
    workflow,
    "--input",
    inputValue,
    "--workspace",
    repositoryRoot,
  ];
  return output === "json"
    ? [...args, "--json"]
    : [...args, "--output", output];
}

async function startExternalOpenCodeFixture(): Promise<{
  readonly port: number;
  readonly requests: string[];
  readonly url: string;
  close(): Promise<void>;
}> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const path = request.url ?? "/";
    requests.push(path);
    if (request.method === "GET" && path === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html><body>OpenCode</body></html>");
      return;
    }
    if (request.method === "GET" && path === "/provider") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          all: [
            {
              id: "openai",
              models: { "gpt-5.6-luna": { id: "gpt-5.6-luna" } },
            },
          ],
          default: { openai: "gpt-5.6-luna" },
          connected: ["openai"],
        }),
      );
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("External OpenCode fixture did not expose a TCP port");
  }
  return {
    port: address.port,
    requests,
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      ),
  };
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
            modulePath: join(
              repositoryRoot,
              "workflows/local-only-example/workflow.ts",
            ),
            description: "A discovered local-only workflow",
          }
        : {
            name: "discovered-minimal",
            modulePath: join(
              repositoryRoot,
              "workflows/minimal-example/workflow.ts",
            ),
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
        productionEntry,
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
          onStarted: (child) => child.kill("SIGTERM"),
          startMarker: "Seqlane operational host:",
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

  it("runs compiled local-only workflows through the installed entrypoint", async () => {
    const result = await runCli(productionEntry, [
      "run",
      localOnlyWorkflowReference,
      "--input",
      '{"value":"local"}',
      "--json",
    ]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "succeeded",
      output: { value: "local" },
    });
  });

  it("builds workflow input from dotted flags", async () => {
    const result = await runCli(productionEntry, [
      "run",
      localOnlyWorkflowReference,
      "--input.value",
      "local",
      "--json",
    ]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "succeeded",
      output: { value: "local" },
    });
  });

  it("supports equals syntax for dotted workflow input flags", async () => {
    const result = await runCli(productionEntry, [
      "run",
      localOnlyWorkflowReference,
      "--input.value=local",
      "--json",
    ]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "succeeded",
      output: { value: "local" },
    });
  });

  it("reports a missing dotted input value with the public flag name", async () => {
    const result = await runCli(productionEntry, [
      "run",
      localOnlyWorkflowReference,
      "--input.value",
      "--dry",
    ]);

    expect(result.code).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "--input.value requires a value",
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain("input-param");
  });

  it("loads the preparse hook from source in the development entrypoint", async () => {
    const result = await runCli(developmentEntry, [
      "run",
      localOnlyWorkflowReference,
      "--input.value",
      "local",
      "--json",
    ]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "succeeded",
      output: { value: "local" },
    });
  });

  it("rejects combining dotted and JSON input sources", async () => {
    const result = await runCli(productionEntry, [
      "run",
      localOnlyWorkflowReference,
      "--input",
      '{"value":"local"}',
      "--input.value",
      "other",
      "--dry",
    ]);

    expect(result.code).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "use only one of --input, --input-file, or --input.<path>",
    );
  });

  it("uses Oclif relationships to keep JSON and file inputs exclusive", async () => {
    const result = await runCli(productionEntry, [
      "run",
      localOnlyWorkflowReference,
      "--input",
      '{"value":"local"}',
      "--input-file",
      "./input.json",
      "--dry",
    ]);

    expect(result.code).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "cannot also be provided when using",
    );
  });

  it("rejects catalog aliases for run", async () => {
    const result = await runCli(productionEntry, [
      "run",
      "repository:discovered-local-only",
      "--input",
      '{"value":"local"}',
    ]);

    expect(result.code).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "run requires an explicit workflow file",
    );
  });

  it("keeps explicit JSON output machine-readable at the CLI boundary", async () => {
    const result = await runCli(productionEntry, [
      "run",
      localOnlyWorkflowReference,
      "--input",
      '{"value":"local"}',
      "--json",
    ]);

    expect(result.code).toBe(0);
    const record = JSON.parse(result.stdout) as { status: string };
    expect(record.status).toBe("succeeded");
    expect(result.stdout).not.toContain('"type":"run.');
    expectNoSeqlaneDiagnostics(result.stderr);
  });

  it("rejects the removed runtime flag", async () => {
    const result = await runCli(productionEntry, [
      "run",
      workflowReference,
      "--input",
      input,
      "--runtime",
      "opencode",
    ]);

    expect(result.code).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("--runtime");
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
          planNodeId: "minimal-example-prepare:1",
          type: "task",
          taskId: "minimal-example-prepare",
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
          planNodeId: "minimal-example-finish:1",
          type: "task",
          taskId: "minimal-example-finish",
        },
      ],
    });
    expect(result.stderr).toBe("");
  });

  it("rejects native JSON mode for the dry-run Plan path", async () => {
    const result = await runCli(productionEntry, [
      "run",
      exampleWorkflowReference,
      "--input",
      builtinInput,
      "--dry",
      "--json",
    ]);

    expect(result.code).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "--json cannot be combined with --dry",
    );
  });

  it("reads workflow input from a JSON file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "seqlane-input-cli-"));
    const path = join(directory, "input.json");
    writeFileSync(path, builtinInput);

    try {
      const result = await runCli(productionEntry, [
        "run",
        exampleWorkflowReference,
        "--input-file",
        path,
        "--dry",
      ]);

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        workflow: { id: "minimal-example" },
      });
      expect(result.stderr).toBe("");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reads workflow input from stdin only when the file flag is explicit", async () => {
    const result = await runCli(
      productionEntry,
      ["run", exampleWorkflowReference, "--input-file", "-", "--dry"],
      { stdin: builtinInput },
    );

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      workflow: { id: "minimal-example" },
    });
    expect(result.stderr).toBe("");
  });

  it("rejects a JSON input file larger than 1 MiB before parsing", async () => {
    const directory = mkdtempSync(join(tmpdir(), "seqlane-input-limit-cli-"));
    const path = join(directory, "input.json");
    writeFileSync(path, Buffer.alloc(1_048_577, 32));

    try {
      const result = await runCli(productionEntry, [
        "run",
        exampleWorkflowReference,
        "--input-file",
        path,
        "--dry",
      ]);

      expect(result.code).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain(
        "--input-file could not be read: file exceeds the 1048576-byte limit",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("validates an empty object when no workflow input source is provided", async () => {
    const result = await runCli(productionEntry, [
      "run",
      localOnlyWorkflowReference,
      "--json",
    ]);

    expect(result.code).toBe(1);
    expect(`${result.stdout}${result.stderr}`).not.toContain(
      "specify exactly one",
    );
    expect(`${result.stdout}${result.stderr}`).toMatch(/value|input/i);
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
      /runtime profile.*not configured|model capabilities are unavailable/i,
    );
  });

  it("does not inherit direct adapter bootstrap without --adapter", async () => {
    const result = await runCli(
      productionEntry,
      ["run", exampleWorkflowReference, "--input", builtinInput],
      {
        environment: {
          SEQLANE_CLI_DIRECT_ADAPTER_CONFIG: JSON.stringify({
            adapter: "codex",
          }),
        },
      },
    );

    expect(result.code).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toMatch(
      /runtime profile.*not configured|model capabilities are unavailable/i,
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain(
      "Codex requires a workspace",
    );
  });

  it("exposes only OpenCode-scoped connection flags", async () => {
    const help = await runCli(productionEntry, ["run", "--help"]);

    expect(help.code).toBe(0);
    expect(help.stdout).toContain("--opencode-mode");
    expect(help.stdout).toContain("--opencode-host");
    expect(help.stdout).toContain("--opencode-port");
    expect(help.stdout).not.toContain("--input-param");
    expect(help.stdout).toMatch(
      /--opencode-mode[\s\S]*OpenCode connection mode\. Defaults to managed\./,
    );
    expect(help.stdout).not.toContain("--adapter-host");
    expect(help.stdout).not.toContain("--adapter-port");
  });

  it("serializes the managed OpenCode default for the compiled child", async () => {
    const directory = mkdtempSync(join(tmpdir(), "seqlane-cli-opencode-"));
    const bin = join(directory, "bin");
    const spawnMarker = join(directory, "managed-spawned");
    mkdirSync(bin);
    const opencode = join(bin, "opencode");
    writeFileSync(
      opencode,
      '#!/bin/sh\nprintf \'%s\' "$*" > "$SEQLANE_TEST_OPENCODE_SPAWNED"\nexit 1\n',
    );
    chmodSync(opencode, 0o755);

    try {
      const result = await runCli(
        productionEntry,
        [
          "run",
          exampleWorkflowReference,
          "--input",
          builtinInput,
          "--json",
          "--adapter",
          "opencode",
        ],
        {
          environment: {
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            SEQLANE_TEST_OPENCODE_SPAWNED: spawnMarker,
          },
        },
      );

      expect(result.code).toBe(1);
      expect(readFileSync(spawnMarker, "utf8")).toBe(
        "serve --hostname=127.0.0.1 --port=0 --print-logs",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("validates the OpenCode connection flag matrix", async () => {
    const externalDryRun = await runCli(productionEntry, [
      "run",
      localOnlyWorkflowReference,
      "--input",
      '{"value":"local"}',
      "--dry",
      "--adapter",
      "opencode",
      "--opencode-mode",
      "external",
      "--opencode-host",
      "127.0.0.1",
      "--opencode-port",
      "1",
    ]);
    expect(externalDryRun.code).toBe(0);

    const missingExternalEndpoint = await runCli(productionEntry, [
      "run",
      localOnlyWorkflowReference,
      "--input",
      '{"value":"local"}',
      "--dry",
      "--adapter",
      "opencode",
      "--opencode-mode",
      "external",
    ]);
    expect(missingExternalEndpoint.code).not.toBe(0);

    const missingAdapter = await runCli(productionEntry, [
      "run",
      localOnlyWorkflowReference,
      "--input",
      '{"value":"local"}',
      "--dry",
      "--opencode-mode",
      "managed",
    ]);
    expect(missingAdapter.code).not.toBe(0);
    expect(`${missingAdapter.stdout}${missingAdapter.stderr}`).toMatch(
      /All of the following must be provided when using --opencode-mode:[\s\S]*--adapter/,
    );

    const invalidExternalPort = await runCli(productionEntry, [
      "run",
      localOnlyWorkflowReference,
      "--input",
      '{"value":"local"}',
      "--dry",
      "--adapter",
      "opencode",
      "--opencode-mode",
      "external",
      "--opencode-host",
      "127.0.0.1",
      "--opencode-port",
      "0",
    ]);
    expect(invalidExternalPort.code).not.toBe(0);

    const codexFlag = await runCli(productionEntry, [
      "run",
      localOnlyWorkflowReference,
      "--input",
      '{"value":"local"}',
      "--dry",
      "--adapter",
      "codex",
      "--opencode-host",
      "127.0.0.1",
    ]);
    expect(codexFlag.code).not.toBe(0);
    expect(`${codexFlag.stdout}${codexFlag.stderr}`).toContain(
      "--adapter=codex cannot also be provided when using --opencode-host",
    );

    const removedFlag = await runCli(productionEntry, [
      "run",
      localOnlyWorkflowReference,
      "--input",
      '{"value":"local"}',
      "--dry",
      "--adapter-host",
      "127.0.0.1",
    ]);
    expect(removedFlag.code).not.toBe(0);
  }, 15_000);

  it("passes external OpenCode mode through the compiled child without service ownership", async () => {
    const fixture = await startExternalOpenCodeFixture();
    const directory = mkdtempSync(join(tmpdir(), "seqlane-cli-opencode-"));
    const bin = join(directory, "bin");
    const managedSpawnMarker = join(directory, "managed-spawned");
    mkdirSync(bin);
    const opencode = join(bin, "opencode");
    writeFileSync(
      opencode,
      '#!/bin/sh\nprintf managed > "$SEQLANE_TEST_OPENCODE_SPAWNED"\nexit 1\n',
    );
    chmodSync(opencode, 0o755);

    try {
      const result = await runCli(
        productionEntry,
        [
          "run",
          exampleWorkflowReference,
          "--input",
          builtinInput,
          "--json",
          "--adapter",
          "opencode",
          "--opencode-mode",
          "external",
          "--opencode-host",
          "127.0.0.1",
          "--opencode-port",
          String(fixture.port),
        ],
        {
          environment: {
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            SEQLANE_TEST_OPENCODE_SPAWNED: managedSpawnMarker,
          },
        },
      );

      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: "failed" });
      expect(fixture.requests).toEqual(
        expect.arrayContaining(["/", "/provider"]),
      );
      expect(existsSync(managedSpawnMarker)).toBe(false);
      expect((await fetch(fixture.url)).ok).toBe(true);
    } finally {
      await fixture.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("runs a local-only workflow without a runtime profile", async () => {
    const result = await runCli(productionEntry, [
      "run",
      localOnlyWorkflowReference,
      "--input",
      '{"value":"local"}',
      "--json",
    ]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "succeeded" });
  });

  it("runs a deterministic task-until workflow through the CLI", async () => {
    const result = await runCli(productionEntry, [
      "run",
      untilWorkflowReference,
      "--input",
      '{"remaining":3,"attempts":0}',
      "--json",
    ]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "succeeded",
      output: { remaining: 0, attempts: 3 },
    });
  });

  it("returns a failed JSON result for a non-JSON workflow output", async () => {
    const directory = mkdtempSync(
      join(repositoryRoot, ".tmp-seqlane-non-json-cli-"),
    );
    const workflowPath = join(directory, "non-json.ts");
    writeFileSync(
      workflowPath,
      `import { createFlow, defineTask } from "@seqlane/core";
import { z } from "zod";

const input = z.object({});
const output = z.any();
const task = defineTask({
  id: "non-json.value",
  input,
  output,
  execute: async () => undefined,
});

export default createFlow({ id: "non-json", input, output })
  .task("value", task, () => ({}))
  .output(({ tasks }) => tasks.value.output)
  .define();
`,
    );

    try {
      const result = await runCli(productionEntry, [
        "run",
        workflowPath,
        "--input",
        "{}",
        "--json",
        "--workspace",
        repositoryRoot,
      ]);

      expect(result.code).toBe(1);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: 1,
        status: "failed",
        phase: "execution",
        error: {
          message: expect.stringContaining(
            "Seqlane run output must be JSON serializable",
          ),
        },
      });
      expect(result.stdout).not.toContain('"type":"run.');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("runs a TypeScript workflow file through its default export", async () => {
    const result = await runCli(productionEntry, [
      "run",
      localOnlyWorkflowReference,
      "--input",
      '{"value":"local"}',
      "--json",
    ]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "succeeded" });
  });

  it("rejects removed recording support", async () => {
    const directory = mkdtempSync(join(tmpdir(), "seqlane-recording-cli-"));
    const path = join(directory, "run.jsonl");
    try {
      const result = await runCli(productionEntry, [
        "run",
        localOnlyWorkflowReference,
        "--input",
        '{"value":"local"}',
        "--record",
        path,
      ]);

      expect(result.code).toBe(2);
      expect(`${result.stdout}${result.stderr}`).toContain("Nonexistent flag");
    } finally {
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
        "--events",
        "ndjson",
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

  it("prints one concise contextual error for a malformed recording", async () => {
    const directory = mkdtempSync(join(tmpdir(), "seqlane-replay-error-cli-"));
    const path = join(directory, "invalid.jsonl");
    writeFileSync(path, "not-json\n");
    try {
      const result = await runCli(productionEntry, [
        "replay",
        path,
        "--output",
        "human",
      ]);

      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Could not read recording:");
      expect(result.stderr).toContain("Invalid recording header JSON");
      expect(result.stderr).not.toContain("Caused by:");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects invalid input before starting a runner", async () => {
    const result = await runCli(productionEntry, runArgs("{"));

    expect(result.code).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/input|JSON/i);
    expect(result.stdout).not.toContain("workflow started");
  });
});
