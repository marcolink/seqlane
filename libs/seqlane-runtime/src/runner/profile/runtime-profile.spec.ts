import { once } from "node:events";
import { createServer, type Server, type ServerResponse } from "node:http";
import type {
  TaskDefinition,
  TaskDefinitionRegistry,
  SeqlaneSchema,
} from "@seqlane/core";
import type { AgentAdapter, AgentAdapterRequest } from "@seqlane/agent-adapter";
import { RequestContext } from "@mastra/core/request-context";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  executeAgentAdapterRequest,
  resolveRuntimeProfile,
} from "./runtime-profile.js";
import { createRuntimeAdapterRegistry } from "./runtime-adapter.js";
import type { ExecutorRequest } from "../../runtime/execution/executor.js";

const schema: SeqlaneSchema = { parse: (value) => value };
const checkpointBindingSchema = z.object({
  configurationBinding: z.string(),
});

function writeJson(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function startOpenCodeServer(): Promise<{
  readonly sessionRequests: readonly unknown[];
  readonly url: string;
  close(): Promise<void>;
}> {
  const sessionRequests: string[] = [];
  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/provider") {
      writeJson(response, {
        all: [
          {
            id: "openai",
            models: { "gpt-5.6-luna": { id: "gpt-5.6-luna" } },
          },
          {
            id: "anthropic",
            models: { "claude-sonnet-4-6": { id: "claude-sonnet-4-6" } },
          },
        ],
        default: { openai: "gpt-5.6-luna" },
        connected: ["openai", "anthropic"],
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/config/providers") {
      writeJson(response, {
        providers: [
          {
            id: "openai",
            models: { "gpt-5.6-luna": { id: "gpt-5.6-luna" } },
          },
          {
            id: "anthropic",
            models: { "claude-sonnet-4-6": { id: "claude-sonnet-4-6" } },
          },
        ],
        default: { openai: "gpt-5.6-luna" },
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/session") {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      sessionRequests.push(body);
      writeJson(response, {
        id: "session-1",
        directory: process.cwd(),
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("OpenCode test server did not expose a TCP address");
  }

  return {
    sessionRequests,
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

function task(id: string, workspace: "shared" | "exclusive"): TaskDefinition {
  return {
    id,
    workspace,
    input: schema,
    output: schema,
    goal: () => "complete the task",
  };
}

function openCodeOptions(url: string) {
  return {
    adapterConfiguration: {
      adapter: "opencode" as const,
      url,
    },
  };
}

describe("resolveRuntimeProfile", () => {
  it("does not forward model selection to adapters without that capability", async () => {
    const source = task("source", "shared");
    const tasks: TaskDefinitionRegistry = new Map([[source.id, source]]);
    const selection = {
      model: { provider: "anthropic", model: "claude-sonnet-4-6" },
      reasoning: "high" as const,
    };
    let received: AgentAdapterRequest | undefined;
    const adapter: AgentAdapter = {
      capabilities: {
        execute: true,
        modelSelection: false,
        structuredOutput: true,
        sessionReuse: true,
        checkpoint: false,
        fork: false,
        activity: true,
        sessionUi: false,
      },
      execute: async (request) => {
        received = request;
        return { value: "done" };
      },
    };
    const observability = { tracing: "invocation-context" };
    const request: ExecutorRequest = {
      invocationId: "invocation:source",
      observability: observability as never,
      taskId: source.id,
      executor: "agent",
      input: null,
      signal: new AbortController().signal,
    };

    await expect(
      executeAgentAdapterRequest(adapter, tasks, selection, request),
    ).resolves.toEqual({ value: "done" });
    expect(received).toBeDefined();
    expect(received).not.toHaveProperty("modelSelection");
    expect(received?.observability).toBe(observability);
  });

  it("forwards lifecycle callbacks through the private adapter boundary", async () => {
    const source = task("source", "shared");
    const tasks: TaskDefinitionRegistry = new Map([[source.id, source]]);
    const termination = Promise.resolve();
    const uncertainActivities: unknown[] = [];
    const backgroundProcesses: unknown[] = [];
    const adapter: AgentAdapter = {
      capabilities: {
        execute: true,
        modelSelection: false,
        structuredOutput: true,
        sessionReuse: true,
        checkpoint: false,
        fork: false,
        activity: true,
        sessionUi: false,
      },
      execute: async (received) => {
        received.onUncertainActivity?.({ reason: "timeout", termination });
        received.onBackgroundProcess?.({
          mutatesWorkspace: true,
          termination,
        });
        return { value: "done" };
      },
    };
    const request: ExecutorRequest = {
      invocationId: "invocation:source",
      observability: {},
      taskId: source.id,
      executor: "agent",
      input: null,
      signal: new AbortController().signal,
      onUncertainActivity: (activity) => uncertainActivities.push(activity),
      onBackgroundProcess: (process) => backgroundProcesses.push(process),
    };

    await expect(
      executeAgentAdapterRequest(adapter, tasks, undefined, request),
    ).resolves.toEqual({ value: "done" });
    expect(uncertainActivities).toEqual([{ reason: "timeout", termination }]);
    expect(backgroundProcesses).toEqual([
      { mutatesWorkspace: true, termination },
    ]);
  });

  it("resolves local workspace resources without contacting OpenCode", async () => {
    const local: TaskDefinition = {
      id: "local-task",
      input: schema,
      output: schema,
      execute: async (input) => input,
    };

    const execution = await resolveRuntimeProfile(
      { id: "local", workspace: process.cwd() },
      new Map([[local.id, local]]),
      new AbortController().signal,
      null,
    );

    expect(execution.workspaceResources.get(local.id)).toEqual({
      key: process.cwd(),
    });
  });

  it("does not derive OpenCode authority from task workspace policy", async () => {
    const server = await startOpenCodeServer();
    const sharedTask = task("shared-task", "shared");
    const exclusiveTask = task("exclusive-task", "exclusive");
    const tasks: TaskDefinitionRegistry = new Map([
      [sharedTask.id, sharedTask],
      [exclusiveTask.id, exclusiveTask],
    ]);

    try {
      const execution = await resolveRuntimeProfile(
        { id: server.url, workspace: process.cwd() },
        tasks,
        new AbortController().signal,
        null,
        undefined,
        openCodeOptions(server.url),
      );

      expect(execution).not.toHaveProperty("enforcedWorkspaceCapabilities");
      const first = await execution.sessionResolver.resolve({
        invocationId: "invocation:shared",
        task: sharedTask,
      });
      const second = await execution.sessionResolver.resolve({
        invocationId: "invocation:exclusive",
        task: exclusiveTask,
      });

      expect(first.key).not.toBe(second.key);
      expect(server.sessionRequests).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("resolves OpenCode sessions with native checkpoint and fork capabilities", async () => {
    const server = await startOpenCodeServer();
    const source = task("source", "shared");
    const tasks: TaskDefinitionRegistry = new Map([[source.id, source]]);

    try {
      const execution = await resolveRuntimeProfile(
        { id: server.url, workspace: process.cwd() },
        tasks,
        new AbortController().signal,
        null,
        undefined,
        openCodeOptions(server.url),
      );
      const selection = {
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
        reasoning: "high" as const,
      };
      const session = await execution.sessionResolver.resolve({
        invocationId: "invocation:source",
        task: source,
        effectiveSelection: selection,
      });

      expect(session.checkpoint).toBeTypeOf("function");
      expect(session.fork).toBeTypeOf("function");
      expect(session.effectiveSelection).toEqual(selection);
    } finally {
      await server.close();
    }
  });

  it("uses opaque resolution bindings for checkpoints and rejects foreign configurations", async () => {
    const source = task("source", "shared");
    const tasks: TaskDefinitionRegistry = new Map([[source.id, source]]);
    const capabilities = {
      execute: true as const,
      modelSelection: false,
      structuredOutput: true,
      sessionReuse: true,
      checkpoint: true,
      fork: true,
      activity: false,
      sessionUi: false,
    };
    const createAdapter = (): AgentAdapter => ({
      capabilities,
      execute: async () => ({ value: "done" }),
      captureCheckpoint: async () => "checkpoint",
      fork: async () => createAdapter(),
    });
    const adapterRegistry = createRuntimeAdapterRegistry([
      {
        identity: "opencode",
        resolveCapabilities: () => capabilities,
        prepare: async () => ({}),
        create: () => ({ createAdapter }),
      },
    ]);
    const resolve = (url: string) =>
      resolveRuntimeProfile(
        { id: url, workspace: process.cwd() },
        tasks,
        new AbortController().signal,
        null,
        undefined,
        {
          adapterConfiguration: { adapter: "opencode", url },
          adapterRegistry,
          runId: "run-1",
        },
      );
    const execute = async (session: {
      readonly executor: {
        execute(request: ExecutorRequest): Promise<unknown>;
      };
    }) => {
      await session.executor.execute({
        invocationId: "invocation:source",
        observability: {},
        taskId: source.id,
        executor: "agent",
        input: null,
        signal: new AbortController().signal,
      });
    };

    const first = await resolve("http://adapter-a.test");
    const firstSession = await first.sessionResolver.resolve({
      invocationId: "invocation:source",
      task: source,
    });
    await execute(firstSession);
    const firstCheckpoint = await firstSession.checkpoint?.();
    expect(firstCheckpoint).toMatchObject({
      configurationBinding: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    });
    expect(firstCheckpoint).not.toHaveProperty("configurationFingerprint");
    const firstBinding = checkpointBindingSchema.parse(firstCheckpoint);

    const second = await resolve("http://adapter-a.test");
    const secondSession = await second.sessionResolver.resolve({
      invocationId: "invocation:source",
      task: source,
    });
    await execute(secondSession);
    const secondCheckpoint = await secondSession.checkpoint?.();
    expect(
      checkpointBindingSchema.parse(secondCheckpoint).configurationBinding,
    ).not.toBe(firstBinding.configurationBinding);

    const foreign = await resolve("http://adapter-b.test");
    const foreignSession = await foreign.sessionResolver.resolve({
      invocationId: "invocation:branch",
      task: source,
    });
    if (foreignSession.fork === undefined || firstCheckpoint === undefined) {
      throw new Error("test adapter did not expose checkpoint and fork");
    }
    await expect(
      foreignSession.fork({
        checkpoint: firstCheckpoint,
        invocationId: "invocation:branch",
        task: source,
      }),
    ).rejects.toMatchObject({ reason: "foreign" });
  });

  it("rejects a forked adapter whose capabilities drift from the source", async () => {
    const source = task("source", "shared");
    const tasks: TaskDefinitionRegistry = new Map([[source.id, source]]);
    const capabilities = {
      execute: true as const,
      modelSelection: false,
      structuredOutput: true,
      sessionReuse: true,
      checkpoint: true,
      fork: true,
      activity: false,
      sessionUi: false,
    };
    const child: AgentAdapter = {
      capabilities: {
        ...capabilities,
        checkpoint: false,
        fork: false,
      },
      execute: async () => ({ value: "child" }),
    };
    const parent: AgentAdapter = {
      capabilities,
      execute: async () => ({ value: "parent" }),
      captureCheckpoint: async () => "checkpoint",
      fork: async () => child,
    };
    const adapterRegistry = createRuntimeAdapterRegistry([
      {
        identity: "opencode",
        resolveCapabilities: () => capabilities,
        prepare: async () => ({}),
        create: () => ({ createAdapter: () => parent }),
      },
    ]);

    const execution = await resolveRuntimeProfile(
      { id: "http://adapter.test", workspace: process.cwd() },
      tasks,
      new AbortController().signal,
      null,
      undefined,
      {
        adapterConfiguration: {
          adapter: "opencode",
          url: "http://adapter.test",
        },
        adapterRegistry,
        runId: "run-1",
      },
    );
    const session = await execution.sessionResolver.resolve({
      invocationId: "invocation:source",
      task: source,
    });
    await session.executor.execute({
      invocationId: "invocation:source",
      observability: {},
      taskId: source.id,
      executor: "agent",
      input: null,
      signal: new AbortController().signal,
    });
    if (session.checkpoint === undefined || session.fork === undefined) {
      throw new Error("test adapter did not expose checkpoint and fork");
    }
    const checkpoint = await session.checkpoint();

    await expect(
      session.fork({
        checkpoint,
        invocationId: "invocation:branch",
        task: source,
      }),
    ).rejects.toThrow(/capability/i);
  });

  it("validates the adapter instance only when its session is created", async () => {
    const source = task("source", "shared");
    const tasks: TaskDefinitionRegistry = new Map([[source.id, source]]);
    let adapterCreations = 0;
    let receivedRequestContext: RequestContext | undefined;
    const capabilities = {
      execute: true as const,
      modelSelection: false,
      structuredOutput: true,
      sessionReuse: true,
      checkpoint: false,
      fork: false,
      activity: false,
      sessionUi: false,
    };
    const adapter: AgentAdapter = {
      capabilities,
      execute: async () => ({ value: "done" }),
    };
    const adapterRegistry = createRuntimeAdapterRegistry([
      {
        identity: "acp",
        resolveCapabilities: () => capabilities,
        prepare: async () => ({}),
        create: (_configuration, context) => {
          receivedRequestContext = context.requestContext;
          return {
            createAdapter: () => {
              adapterCreations += 1;
              return adapter;
            },
          };
        },
      },
    ]);

    const execution = await resolveRuntimeProfile(
      { id: "http://adapter.test", workspace: process.cwd() },
      tasks,
      new AbortController().signal,
      null,
      undefined,
      {
        adapterConfiguration: {
          adapter: "acp",
          configuration: {
            id: "test-agent",
            description: "test agent",
            command: "agent",
            persistSession: true,
          },
        },
        adapterRegistry,
        requestContext: new RequestContext([["request", "value"]]),
      },
    );

    expect(adapterCreations).toBe(0);
    expect(receivedRequestContext).toBeInstanceOf(RequestContext);
    await execution.sessionResolver.resolve({
      invocationId: "invocation:source",
      task: source,
    });
    expect(adapterCreations).toBe(1);
  });

  it("exposes the OpenCode model catalog and configured default", async () => {
    const server = await startOpenCodeServer();
    const source = task("source", "shared");
    const tasks: TaskDefinitionRegistry = new Map([[source.id, source]]);

    try {
      const execution = await resolveRuntimeProfile(
        { id: server.url, workspace: process.cwd() },
        tasks,
        new AbortController().signal,
        null,
        undefined,
        openCodeOptions(server.url),
      );

      await expect(
        execution.sessionResolver.modelCapabilities?.listModels(),
      ).resolves.toEqual([
        { provider: "openai", model: "gpt-5.6-luna" },
        { provider: "anthropic", model: "claude-sonnet-4-6" },
      ]);
      await expect(
        execution.sessionResolver.modelCapabilities?.resolveDefaultModel(),
      ).resolves.toEqual({
        model: { provider: "openai", model: "gpt-5.6-luna" },
      });
    } finally {
      await server.close();
    }
  });
});
