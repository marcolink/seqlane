import { once } from "node:events";
import { createServer, type Server, type ServerResponse } from "node:http";
import type {
  TaskDefinition,
  TaskDefinitionRegistry,
  SeqlaneSchema,
} from "@seqlane/core";
import { describe, expect, it } from "vitest";
import { resolveRuntimeProfile } from "./runtime-profile.js";

const schema: SeqlaneSchema = { parse: (value) => value };

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

describe("resolveRuntimeProfile", () => {
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
