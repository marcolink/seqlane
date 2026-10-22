// @test-scope ./commands/run.ts
// @test-scope ./runner-client.ts
// @test-scope ./test-fixtures/effect-worker-test-support.ts
// @test-scope ./test-fixtures/effect-native-runner.ts
// @test-scope ./test-fixtures/effect-native-workflow.ts
// @test-scope ./test-fixtures/effect-native-codex-server.ts
// @test-scope ./test-fixtures/effect-native-opencode-server.ts
// @test-scope ../../../libs/runtime/src/runtime/execution/effect-plan.ts
// @test-scope ../../../libs/runtime/src/runner/profile/runtime-profile.ts
// @test-scope ../../../libs/opencode/src/adapter.ts
// @test-scope ../../../libs/opencode/src/runtime.ts
// @test-scope ../../../libs/codex/src/adapter.ts
// @test-scope ../../../libs/codex/src/runtime.ts

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  isRunRequest,
  type RunRequest,
  type SeqlaneExecutionEvent,
} from "@seqlane/protocol";
import { launchRunner } from "./runner-client.js";
import { telemetryConfigurationEnvironment } from "@seqlane/runtime/private/telemetry";
import { runCommandResultSchema } from "./cli-contracts.js";
import {
  closeRunnerWorker,
  prepareExternalCli,
  startCompiledCli,
} from "./test-fixtures/effect-worker-test-support.js";
import {
  nativeFixtureResult,
  startNativeOpenCodeServer,
} from "./test-fixtures/effect-native-opencode-server.js";

const cliRoot = fileURLToPath(new URL("../", import.meta.url));
const runnerPath = join(cliRoot, "dist/test-fixtures/effect-native-runner.js");
const workflowUrl = pathToFileURL(
  join(cliRoot, "dist/test-fixtures/effect-native-workflow.js"),
).href;
const traceSchema = z.object({
  method: z.string(),
  params: z.unknown().optional(),
});
const correlationSchema = z.object({ threadId: z.string() });
const processSchema = z.object({ pid: z.number().int().positive() });
const otlpTracePayloadSchema = z.object({
  resourceSpans: z.array(
    z.object({
      scopeSpans: z.array(
        z.object({
          spans: z.array(
            z.object({
              name: z.string(),
              traceId: z.string(),
              spanId: z.string(),
              parentSpanId: z.string().optional(),
              attributes: z.array(
                z.object({
                  key: z.string(),
                  value: z
                    .object({ stringValue: z.string().optional() })
                    .passthrough(),
                }),
              ),
            }),
          ),
        }),
      ),
    }),
  ),
});
let temporaryRoot: string;
let consumerRoot: string;
let codexExecutable: string;

beforeAll(() => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "seqlane-effect-native-"));
  consumerRoot = prepareExternalCli({
    cliRoot,
    destination: join(temporaryRoot, "consumer"),
    runnerEntrypoint: "./dist/test-fixtures/effect-native-runner.js",
  });
  codexExecutable = join(consumerRoot, "fixture-codex.js");
  const source = readFileSync(
    join(cliRoot, "dist/test-fixtures/effect-native-codex-server.js"),
    "utf8",
  );
  writeFileSync(codexExecutable, `#!/usr/bin/env node\n${source}`, {
    mode: 0o755,
  });
});

afterAll(() => rmSync(temporaryRoot, { recursive: true, force: true }));

async function nativePeer(
  adapter: "opencode" | "codex",
  mode: "success" | "hold" = "success",
) {
  const trace = join(
    mkdtempSync(join(temporaryRoot, `${adapter}-`)),
    "requests.jsonl",
  );
  const server =
    adapter === "opencode" ? await startNativeOpenCodeServer(mode) : undefined;
  const requests = () =>
    server === undefined
      ? existsSync(trace)
        ? readFileSync(trace, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => traceSchema.parse(JSON.parse(line)))
        : []
      : server.requests.map((request) => ({
          method: `${request.method} ${request.path}`,
          params: request.body,
        }));
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    FORCE_COLOR: "0",
    SEQLANE_NATIVE_FIXTURE_ADAPTER: adapter,
    SEQLANE_NATIVE_FIXTURE_ENDPOINT: server?.url ?? codexExecutable,
    SEQLANE_NATIVE_FIXTURE_TRACE: trace,
    SEQLANE_NATIVE_FIXTURE_MODE: mode,
  };
  return {
    requests,
    environment,
    close: () => server?.close() ?? Promise.resolve(),
  };
}

function request(exportName = "effectNativeWorkflow"): RunRequest {
  const value: unknown = {
    type: "run.start",
    workflow: {
      id: "effect-native-cli-fixture",
      moduleSpecifier: workflowUrl,
      exportName,
    },
    input: { value: "fixture" },
    runtime: { id: "direct-runtime", workspace: consumerRoot },
  };
  if (!isRunRequest(value))
    throw new Error("Invalid native fixture run request");
  return value;
}

async function runCli(
  adapter: "opencode" | "codex",
  environment: NodeJS.ProcessEnv,
  exportName = "effectNativeWorkflow",
) {
  const invocation = startCompiledCli({
    cliRoot: consumerRoot,
    args: [
      "run",
      `${workflowUrl}#${exportName}`,
      "--input",
      '{"value":"fixture"}',
      "--adapter",
      adapter,
      "--workspace",
      consumerRoot,
      "--json",
    ],
    cwd: consumerRoot,
    env: environment,
  });
  const result = await invocation.completed;
  return {
    code: result.code,
    stderr: result.stderr,
    result: runCommandResultSchema.parse(JSON.parse(result.stdout)),
  };
}

describe.each(["opencode", "codex"] as const)(
  "Effect native %s worker",
  (adapter) => {
    it("rejects an unavailable model before starting a native task", async () => {
      const peer = await nativePeer(adapter);
      try {
        const result = await runCli(
          adapter,
          peer.environment,
          "effectNativeUnsupportedModelWorkflow",
        );
        expect(result.code, result.stderr).toBe(1);
        expect(result.result).toMatchObject({
          status: "failed",
          error: {
            message: expect.stringContaining(
              "does not provide requested model",
            ),
          },
        });
        expect(
          peer
            .requests()
            .some(
              ({ method }) =>
                method === "turn/start" ||
                (method.startsWith("POST ") && method.endsWith("/message")),
            ),
        ).toBe(false);
      } finally {
        await peer.close();
      }
    }, 30_000);

    it("runs the real adapter through compiled Oclif with reuse and checkpoint fork", async () => {
      const peer = await nativePeer(adapter);
      try {
        const result = await runCli(adapter, peer.environment);
        expect(
          result.code,
          JSON.stringify({ ...result, requests: peer.requests() }),
        ).toBe(0);
        expect(result.result).toMatchObject({
          status: "succeeded",
          output: nativeFixtureResult,
        });
        expect(existsSync(join(consumerRoot, ".seqlane"))).toBe(false);
        const requests = peer.requests();
        if (adapter === "codex") {
          expect(
            requests.filter(({ method }) => method === "thread/start"),
          ).toHaveLength(1);
          expect(
            requests.filter(({ method }) => method === "thread/fork"),
          ).toHaveLength(1);
          const turns = requests
            .filter(({ method }) => method === "turn/start")
            .map(({ params }) => correlationSchema.parse(params).threadId);
          expect(turns).toHaveLength(3);
          expect(new Set(turns).size).toBe(2);
        } else {
          expect(
            requests.filter(({ method }) => method === "POST /session"),
          ).toHaveLength(1);
          expect(
            requests.filter(({ method }) => method.endsWith("/fork")),
          ).toHaveLength(1);
          expect(
            requests.filter(
              ({ method }) =>
                method.startsWith("POST ") && method.endsWith("/message"),
            ),
          ).toHaveLength(4);
          expect(requests).toContainEqual(
            expect.objectContaining({
              params: expect.objectContaining({
                tools: { "*": false, StructuredOutput: true },
              }),
            }),
          );
        }
      } finally {
        await peer.close();
      }
    }, 30_000);

    it.skipIf(adapter !== "opencode")(
      "exports one correlated CLI, worker, invocation, adapter, and observation trace",
      async () => {
        const peer = await nativePeer("opencode");
        const batches: Array<{ path: string; body: string }> = [];
        const telemetryServer = createServer((request, response) => {
          const chunks: Buffer[] = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.on("end", () => {
            batches.push({
              path: request.url ?? "",
              body: Buffer.concat(chunks).toString("utf8"),
            });
            response
              .writeHead(200, { "content-type": "application/json" })
              .end("{}");
          });
        });
        await new Promise<void>((resolve) =>
          telemetryServer.listen(0, "127.0.0.1", resolve),
        );
        try {
          const address = telemetryServer.address();
          if (address === null || typeof address === "string") {
            throw new Error("Telemetry test peer did not bind");
          }
          peer.environment[telemetryConfigurationEnvironment] = JSON.stringify({
            endpoint: `http://127.0.0.1:${address.port}`,
            payloadPolicy: "full",
          });
          const result = await runCli(
            "opencode",
            peer.environment,
            "effectNativeMixedWorkflow",
          );
          expect(result.code, result.stderr).toBe(0);
          expect(result.result).toMatchObject({
            status: "succeeded",
            output: nativeFixtureResult,
          });
          expect(result.stderr).not.toContain(
            "seqlane telemetry export failed",
          );
          const trace = batches.find((batch) => batch.path === "/v1/traces");
          expect(trace).toBeDefined();
          const payload = otlpTracePayloadSchema.parse(JSON.parse(trace!.body));
          const spans = payload.resourceSpans.flatMap((resource) =>
            resource.scopeSpans.flatMap((scope) => scope.spans),
          );
          const cli = spans.find((span) => span.name === "seqlane.cli.run");
          const worker = spans.find(
            (span) => span.name === "seqlane.worker.run",
          );
          const runtime = spans.find(
            (span) => span.name === "seqlane.runtime.execution",
          );
          const adapterSpan = spans.find(
            (span) => span.name === "seqlane.adapter.execute",
          );
          const adapterInvocationId = adapterSpan?.attributes.find(
            (attribute) => attribute.key === "seqlane.invocation.id",
          )?.value.stringValue;
          const invocation = spans.find(
            (span) =>
              span.name === "seqlane.invocation" &&
              span.attributes.some(
                (attribute) =>
                  attribute.key === "seqlane.invocation.id" &&
                  attribute.value.stringValue === adapterInvocationId,
              ),
          );
          expect(
            spans.filter((span) => span.name === "seqlane.adapter.execute"),
          ).toHaveLength(1);
          const observation = spans.find((span) =>
            span.attributes.some(
              (attribute) => attribute.key === "seqlane.observation.id",
            ),
          );
          const activity = spans.find((span) =>
            span.attributes.some(
              (attribute) => attribute.key === "seqlane.activity.id",
            ),
          );
          expect(
            worker,
            JSON.stringify({
              stderr: result.stderr,
              names: spans.map((span) => span.name),
            }),
          ).toBeDefined();
          expect(worker?.traceId).toBe(cli?.traceId);
          expect(worker?.parentSpanId).toBe(cli?.spanId);
          expect(runtime?.parentSpanId).toBe(worker?.spanId);
          expect(invocation?.parentSpanId).toBe(runtime?.spanId);
          expect(adapterSpan?.parentSpanId).toBe(invocation?.spanId);
          expect(observation?.parentSpanId).toBe(adapterSpan?.spanId);
          expect(activity?.parentSpanId).toBe(adapterSpan?.spanId);
          expect(spans.every((span) => span.traceId === cli?.traceId)).toBe(
            true,
          );
          expect(batches.some((batch) => batch.path === "/v1/logs")).toBe(true);
          expect(batches.some((batch) => batch.path === "/v1/metrics")).toBe(
            true,
          );
        } finally {
          await peer.close();
          await new Promise<void>((resolve, reject) =>
            telemetryServer.close((error) =>
              error ? reject(error) : resolve(),
            ),
          );
        }
      },
      30_000,
    );

    it("preserves complete native observations and activity values over worker IPC", async () => {
      const peer = await nativePeer(adapter);
      const events: SeqlaneExecutionEvent[] = [];
      const client = launchRunner(request("effectNativeSingleWorkflow"), {
        runnerPath,
        cwd: consumerRoot,
        environment: peer.environment,
        signalSource: null,
        onExecutionEvent: (event) => events.push(event),
      });
      const cancelTimeout = setTimeout(() => client.cancel(), 15_000);
      try {
        const result = await client.result;
        expect(
          result.status,
          JSON.stringify({ result, events, requests: peer.requests() }),
        ).toBe(0);
        expect(events.map((event) => event.metadata.sequence)).toEqual(
          events.map((_, index) => index + 1),
        );
        const model = [...events]
          .reverse()
          .find(
            (event) =>
              event.type === "invocation.observation" &&
              event.state === "succeeded",
          );
        expect(model?.type).toBe("invocation.observation");
        if (model?.type !== "invocation.observation")
          throw new Error("Missing native model observation");
        expect(model.model).toMatchObject({
          provider: "openai",
          model: "fixture-model",
        });
        expect(model.model.request).toBeDefined();
        expect(model.model.response).toBeDefined();
        expect(model.model.startedAt).toBeTypeOf("number");
        expect(model.model.endedAt).toBeTypeOf("number");
        const activity = events.find(
          (event) =>
            event.type === "invocation.activity" &&
            event.state === "succeeded" &&
            event.kind === "tool",
        );
        expect(activity?.type).toBe("invocation.activity");
        if (activity?.type !== "invocation.activity")
          throw new Error("Missing native tool activity");
        expect(activity.input).toMatchObject({
          state: "present",
          value: {
            enabled: false,
            count: 0,
            text: "",
            nested: { items: [""] },
          },
        });
        expect(activity.startedAt).toBe(100);
        expect(activity.endedAt).toBe(200);
        if (adapter === "opencode") {
          expect(model.model.usage).toMatchObject({
            inputTokens: 0,
            outputTokens: 0,
          });
          expect(model.model.response).toMatchObject({
            native: { info: { structured: nativeFixtureResult } },
          });
          expect(activity.output).toEqual({
            state: "present",
            value: JSON.stringify(nativeFixtureResult),
          });
          expect(activity.activityMetadata).toMatchObject({
            state: "present",
            value: {
              enabled: false,
              count: 0,
              text: "",
              nested: { items: [""] },
            },
          });
          expect(events).toContainEqual(
            expect.objectContaining({
              type: "invocation.activity",
              kind: "skill",
              name: "fixture-skill",
              state: "succeeded",
            }),
          );
          expect(model.model.cost).toBe(0);
        } else {
          expect(model.model.usage).toMatchObject({
            total: { inputTokens: 0, outputTokens: 0 },
            last: { inputTokens: 0, outputTokens: 0 },
            modelContextWindow: 0,
          });
          expect(activity.output).toEqual({
            state: "present",
            value: {
              content: [
                { type: "text", text: JSON.stringify(nativeFixtureResult) },
              ],
              structuredContent: nativeFixtureResult,
              _meta: {
                enabled: false,
                count: 0,
                text: "",
                nested: { items: [""] },
              },
            },
          });
          expect(activity.activityMetadata).toMatchObject({
            state: "present",
            value: {
              type: "mcpToolCall",
              server: "fixture",
              tool: "fixture.read",
              status: "completed",
              readOnlyHint: false,
              pluginId: "",
              durationMs: 0,
              error: null,
              result: { structuredContent: nativeFixtureResult },
            },
          });
          const processStart = peer
            .requests()
            .find(({ method }) => method === "process.started");
          expect(processStart).toBeDefined();
          const { pid } = processSchema.parse(processStart?.params);
          expect(() => process.kill(pid, 0)).toThrow();
        }
        expect(events.at(-1)?.type).toBe("run.succeeded");
        expect(
          events.filter((event) => event.type === "run.succeeded"),
        ).toHaveLength(1);
      } finally {
        clearTimeout(cancelTimeout);
        await closeRunnerWorker(client);
        await peer.close();
      }
    }, 30_000);

    it("cancels an active native request through the worker cleanup path", async () => {
      const peer = await nativePeer(adapter, "hold");
      const events: SeqlaneExecutionEvent[] = [];
      const client = launchRunner(request("effectNativeSingleWorkflow"), {
        runnerPath,
        cwd: consumerRoot,
        environment: peer.environment,
        signalSource: null,
        onExecutionEvent: (event) => events.push(event),
      });
      const cancelTimeout = setTimeout(() => client.cancel(), 15_000);
      try {
        const deadline = Date.now() + 10_000;
        while (
          !events.some(
            (event) =>
              event.type === "invocation.activity" && event.state === "started",
          )
        ) {
          if (Date.now() >= deadline)
            throw new Error(
              `Native request never started: ${JSON.stringify(peer.requests())}`,
            );
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        client.cancel();
        const result = await client.result;
        expect(result.status, JSON.stringify(result)).toBe(130);
        expect(events.at(-1)?.type).toBe("run.cancelled");
        expect(
          events.filter((event) => event.type === "run.cancelled"),
        ).toHaveLength(1);
        const started = events.filter(
          (event) =>
            event.type === "invocation.activity" && event.state === "started",
        );
        expect(started).not.toHaveLength(0);
        for (const activity of started) {
          if (activity.type !== "invocation.activity") continue;
          expect(events).toContainEqual(
            expect.objectContaining({
              type: "invocation.activity",
              activityId: activity.activityId,
              state: "failed",
              input: activity.input,
            }),
          );
        }
        expect(
          peer
            .requests()
            .some(
              ({ method }) =>
                method === "turn/interrupt" || method.endsWith("/abort"),
            ),
        ).toBe(true);
        if (adapter === "codex") {
          const processStart = peer
            .requests()
            .find(({ method }) => method === "process.started");
          const { pid } = processSchema.parse(processStart?.params);
          expect(() => process.kill(pid, 0)).toThrow();
        }
      } finally {
        clearTimeout(cancelTimeout);
        await closeRunnerWorker(client);
        await peer.close();
      }
    }, 30_000);
  },
);
