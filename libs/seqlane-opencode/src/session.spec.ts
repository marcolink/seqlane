import { createServer, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createOpenCodeRun, type OpenCodeActivity } from "./session.js";

interface RequestLog {
  readonly method: string;
  readonly path: string;
  readonly body?: string;
}

function isInteractionMonitorPath(path: string): boolean {
  return path === "/event";
}

function writeJson(response: ServerResponse, value: unknown) {
  response.writeHead(200, {
    connection: "close",
    "content-type": "application/json",
  });
  response.end(JSON.stringify(value));
}

function promptResponse(sessionID: string, interaction?: boolean | string) {
  return {
    info: {
      id: `message-${sessionID}`,
      sessionID,
      role: "assistant",
      time: { created: 1, completed: 2 },
      parentID: "message-0",
      modelID: "fake-model",
      providerID: "fake-provider",
      mode: "build",
      agent: "build",
      path: { cwd: "/repo", root: "/repo" },
      cost: 0,
      tokens: {
        total: 0,
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      ...(interaction
        ? {
            error: {
              name: interaction === true ? "PermissionRequired" : interaction,
              data: { message: "approval required" },
            },
          }
        : { structured: { session: sessionID } }),
    },
    parts: [],
  };
}

function textPromptResponse(sessionID: string, text: string) {
  const response = promptResponse(sessionID);
  return {
    ...response,
    info: { ...response.info, structured: undefined },
    parts: [{ type: "text", text }],
  };
}

async function startServer(
  options: {
    readonly interaction?: boolean | string;
    readonly failPrompt?: boolean;
    readonly failInit?: boolean;
    readonly holdPrompt?: boolean;
    readonly holdAbort?: boolean;
    readonly holdSession?: boolean;
    readonly readbackCompatibilityError?: boolean;
    readonly toolEvents?: boolean;
    readonly nextToolEvents?: boolean;
    readonly skillEvents?: boolean;
    readonly backgroundShellEvent?: boolean;
    readonly version?: string;
    readonly promptResponses?: readonly unknown[];
    readonly readbackFailures?: number;
  } = {},
) {
  const requests: RequestLog[] = [];
  let nextSession = 0;
  let resolvePromptStarted: () => void = () => undefined;
  const promptStarted = new Promise<void>((resolve) => {
    resolvePromptStarted = resolve;
  });
  const pendingResponses: Array<{
    readonly response: ServerResponse;
    readonly sessionID: string;
  }> = [];
  const pendingAbortResponses: ServerResponse[] = [];
  let resolveAbortStarted: () => void = () => undefined;
  const abortStarted = new Promise<void>((resolve) => {
    resolveAbortStarted = resolve;
  });
  const eventResponses: ServerResponse[] = [];
  let resolveEventStarted: () => void = () => undefined;
  const eventStarted = new Promise<void>((resolve) => {
    resolveEventStarted = resolve;
  });
  let resolveSessionStarted: () => void = () => undefined;
  const sessionStarted = new Promise<void>((resolve) => {
    resolveSessionStarted = resolve;
  });
  let promptCount = 0;
  let readbackFailures = options.readbackFailures ?? 0;
  const promptCountWaiters: Array<{
    readonly count: number;
    readonly resolve: () => void;
  }> = [];
  const waitForPromptCount = (count: number): Promise<void> => {
    if (promptCount >= count) return Promise.resolve();
    return new Promise((resolve) => {
      promptCountWaiters.push({ count, resolve });
    });
  };
  const markPromptStarted = (): void => {
    promptCount += 1;
    resolvePromptStarted();
    for (let index = promptCountWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = promptCountWaiters[index];
      if (waiter !== undefined && promptCount >= waiter.count) {
        promptCountWaiters.splice(index, 1);
        waiter.resolve();
      }
    }
  };
  const server = createServer(async (request, response) => {
    request.on("aborted", () => response.end());
    const requestPath = request.url ?? "/";
    const path = new URL(requestPath, "http://127.0.0.1").pathname;
    let body = "";
    for await (const chunk of request) {
      body += String(chunk);
    }
    if (
      path !== "/global/health" &&
      !(request.method === "GET" && /\/message$/.test(path))
    ) {
      requests.push({
        method: request.method ?? "",
        path: requestPath,
        ...(body === "" ? {} : { body }),
      });
    }

    if (request.method === "GET" && path === "/global/health") {
      writeJson(response, {
        healthy: true,
        version: options.version ?? "1.14.19",
      });
      return;
    }

    if (request.method === "POST" && path === "/session") {
      resolveSessionStarted();
      if (options.holdSession) return;
      nextSession += 1;
      writeJson(response, {
        id: `session-${nextSession}`,
        projectID: "project-1",
        directory: "/repo",
        title: "Seqlane run",
        version: "1",
        time: { created: nextSession, updated: nextSession },
      });
      return;
    }

    const fork = /^\/session\/(session-\d+)\/fork$/.exec(path);
    if (request.method === "POST" && fork) {
      nextSession += 1;
      writeJson(response, {
        id: `session-${nextSession}`,
        projectID: "project-1",
        directory: "/repo",
        title: "Seqlane branch",
        version: "1",
        time: { created: nextSession, updated: nextSession },
      });
      return;
    }

    const init = /^\/session\/(session-\d+)\/init$/.exec(path);
    if (request.method === "POST" && init) {
      if (options.failInit) {
        response.writeHead(503);
        response.end("OpenCode model initialization failed");
        return;
      }
      writeJson(response, true);
      return;
    }

    const match = /^\/session\/(session-\d+)\/message$/.exec(path);
    if (request.method === "GET" && match) {
      if (readbackFailures > 0) {
        readbackFailures -= 1;
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            name: "BadRequest",
            data: {
              message:
                'Expected OutputFormatJsonSchema, got {...} at [0]["info"]["format"]',
            },
          }),
        );
        return;
      }
      writeJson(response, [promptResponse(match[1] ?? "session-1")]);
      return;
    }
    if (request.method === "POST" && match) {
      const sessionID = match[1];
      if (sessionID === undefined) {
        response.writeHead(400);
        response.end();
        return;
      }
      markPromptStarted();
      if (options.failPrompt) {
        response.writeHead(503);
        response.end("OpenCode unavailable");
        return;
      }
      if (options.holdPrompt) {
        pendingResponses.push({ response, sessionID });
        return;
      }
      writeJson(
        response,
        options.promptResponses?.[promptCount - 1] ??
          promptResponse(sessionID, options.interaction),
      );
      return;
    }

    if (request.method === "GET" && path === "/event") {
      resolveEventStarted();
      response.writeHead(200, {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream",
      });
      eventResponses.push(response);
      if (options.toolEvents) {
        for (const event of [
          {
            type: "message.part.updated",
            properties: {
              sessionID: "session-1",
              part: {
                type: "tool",
                callID: "call-1",
                tool: "filesystem.read",
                state: {
                  status: "running",
                  input: { path: "/repo/package.json" },
                },
              },
            },
          },
          {
            type: "message.part.updated",
            properties: {
              sessionID: "session-1",
              part: {
                type: "tool",
                callID: "call-1",
                tool: "filesystem.read",
                state: { status: "completed", output: "12 bytes" },
              },
            },
          },
        ]) {
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      }
      if (options.nextToolEvents) {
        for (const event of [
          {
            id: "event-tool-called",
            type: "session.next.tool.called",
            properties: {
              sessionID: "session-1",
              callID: "call-next-1",
              tool: "filesystem.read",
              input: { path: "/repo/package.json" },
            },
          },
          {
            id: "event-tool-progress",
            type: "session.next.tool.progress",
            properties: {
              sessionID: "session-1",
              callID: "call-next-1",
              structured: { bytes: 12 },
              content: [],
            },
          },
          {
            id: "event-tool-success",
            type: "session.next.tool.success",
            properties: {
              sessionID: "session-1",
              callID: "call-next-1",
              structured: { bytes: 12 },
              content: [],
              result: { bytes: 12 },
              provider: { executed: true },
            },
          },
        ]) {
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      }
      if (options.skillEvents) {
        for (const event of [
          {
            id: "event-skill-started",
            type: "message.part.updated",
            data: {
              sessionID: "session-1",
              part: {
                type: "tool",
                callID: "skill-call-1",
                tool: "skill",
                state: {
                  status: "running",
                  input: { name: "web-perf" },
                  metadata: {
                    name: "web-perf",
                    dir: "/repo/.agents/skills/web-perf",
                  },
                  time: { start: 100 },
                },
              },
            },
          },
          {
            id: "event-skill-completed",
            type: "message.part.updated",
            data: {
              sessionID: "session-1",
              part: {
                type: "tool",
                callID: "skill-call-1",
                tool: "skill",
                state: {
                  status: "completed",
                  input: { name: "web-perf" },
                  output: "Loaded skill instructions",
                  metadata: {
                    name: "web-perf",
                    dir: "/repo/.agents/skills/web-perf",
                  },
                  time: { start: 100, end: 125 },
                },
              },
            },
          },
        ]) {
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      }
      if (options.backgroundShellEvent) {
        response.write(
          `data: ${JSON.stringify({
            type: "session.next.shell.started",
            properties: {
              sessionID: "session-1",
              callID: "shell-1",
              command: "pnpm format &",
            },
          })}\n\n`,
        );
      }
      response.on("close", () => {
        const index = eventResponses.indexOf(response);
        if (index >= 0) eventResponses.splice(index, 1);
      });
      return;
    }

    const abort = /^\/session\/(session-\d+)\/abort$/.exec(path);
    if (request.method === "POST" && abort) {
      resolveAbortStarted();
      for (const pending of pendingResponses.splice(0)) {
        writeJson(pending.response, {
          info: {
            id: `message-${abort[1]}`,
            sessionID: abort[1],
            role: "assistant",
            time: { created: 1, completed: 2 },
            parentID: "message-0",
            modelID: "fake-model",
            providerID: "fake-provider",
            mode: "build",
            agent: "build",
            path: { cwd: "/repo", root: "/repo" },
            cost: 0,
            tokens: {
              total: 0,
              input: 0,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            error: {
              name: "MessageAbortedError",
              data: { message: "aborted" },
            },
          },
          parts: [],
        });
      }
      if (options.holdAbort) {
        pendingAbortResponses.push(response);
        return;
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
    abortStarted,
    completeNextAbort() {
      const response = pendingAbortResponses.shift();
      if (response === undefined)
        throw new Error("No abort response is pending");
      writeJson(response, true);
    },
    completeNextPrompt() {
      const pending = pendingResponses.shift();
      if (pending === undefined)
        throw new Error("No prompt response is pending");
      writeJson(pending.response, promptResponse(pending.sessionID));
    },
    requests,
    eventStarted,
    publishPermission() {
      for (const response of eventResponses) {
        response.write(
          `data: ${JSON.stringify({
            type: "permission.asked",
            properties: { id: "permission-1", sessionID: "session-1" },
          })}\n\n`,
        );
      }
    },
    closePermissionEvents() {
      for (const response of eventResponses.splice(0)) response.end();
    },
    promptStarted,
    promptCount: () => promptCount,
    sessionStarted,
    server,
    url: `http://127.0.0.1:${address.port}`,
    waitForPromptCount,
  };
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  server.close();
  await once(server, "close");
}

describe("OpenCode run session", () => {
  it("keeps terminal observations out of the streamed event callback", async () => {
    const fake = await startServer();
    try {
      const run = await createOpenCodeRun({ url: fake.url });
      const onObservation = vi.fn();

      await run.prompt({
        text: "task",
        schema: { type: "object" },
        onObservation,
      });

      expect(onObservation).not.toHaveBeenCalled();
    } finally {
      await closeServer(fake.server);
    }
  });

  it("returns the validated terminal observation for adapter reconciliation", async () => {
    const fake = await startServer();
    try {
      const run = await createOpenCodeRun({ url: fake.url });
      const result = await run.prompt({
        text: "task",
        schema: { type: "object" },
      });

      expect(result.observation).toMatchObject({
        kind: "assistant",
        sessionID: "session-1",
        messageID: "message-session-1",
        provider: "fake-provider",
        model: "fake-model",
      });
    } finally {
      await closeServer(fake.server);
    }
  });

  it("binds a session to its configured workspace", async () => {
    const fake = await startServer();
    try {
      const run = await createOpenCodeRun({
        url: fake.url,
        workspace: "/checkout",
      });

      expect(fake.requests).toContainEqual({
        method: "POST",
        path: "/session?directory=%2Fcheckout",
      });
      expect(run.workspace).toBe("/repo");
    } finally {
      await closeServer(fake.server);
    }
  });

  it("exposes a browser URL only when the runtime provides a web UI", async () => {
    const fake = await startServer();
    try {
      const apiOnlyRun = await createOpenCodeRun({ url: fake.url });
      const webRun = await createOpenCodeRun({
        url: fake.url,
        browserUiUrl: fake.url,
      });

      expect(apiOnlyRun.browserUrl).toBeUndefined();
      expect(webRun.browserUrl).toBe(`${fake.url}/L3JlcG8/session/session-2`);
    } finally {
      await closeServer(fake.server);
    }
  });

  it("creates one session per Run and serializes prompts", async () => {
    const fake = await startServer();
    try {
      const run = await createOpenCodeRun({ url: fake.url });
      const results = await Promise.all([
        run.prompt({ text: "first", schema: { type: "object" } }),
        run.prompt({ text: "second", schema: { type: "object" } }),
      ]);

      expect(results).toEqual([
        {
          structured: { session: "session-1" },
          observation: expect.objectContaining({
            sessionID: "session-1",
            messageID: "message-session-1",
          }),
          metrics: {
            durationMs: 1,
            model: "fake-model",
            provider: "fake-provider",
            cost: 0,
            tokens: {
              total: 0,
              input: 0,
              output: 0,
              reasoning: 0,
              cacheRead: 0,
              cacheWrite: 0,
            },
          },
        },
        {
          structured: { session: "session-1" },
          observation: expect.objectContaining({
            sessionID: "session-1",
            messageID: "message-session-1",
          }),
          metrics: {
            durationMs: 1,
            model: "fake-model",
            provider: "fake-provider",
            cost: 0,
            tokens: {
              total: 0,
              input: 0,
              output: 0,
              reasoning: 0,
              cacheRead: 0,
              cacheWrite: 0,
            },
          },
        },
      ]);
      expect(
        fake.requests
          .filter(({ path }) => !isInteractionMonitorPath(path))
          .map(({ path }) => path),
      ).toEqual([
        "/session",
        "/session/session-1/message",
        "/session/session-1/message",
      ]);
    } finally {
      await closeServer(fake.server);
    }
  });

  it("downgrades later auto prompts after a native readback failure", async () => {
    const fake = await startServer({
      readbackFailures: 1,
      promptResponses: [
        promptResponse("session-1"),
        textPromptResponse("session-1", '{"result":"recovered"}'),
      ],
    });
    try {
      const run = await createOpenCodeRun({ url: fake.url });

      await expect(
        run.prompt({ text: "first", schema: { type: "object" } }),
      ).rejects.toMatchObject({
        name: "StructuredOutputCompatibilityError",
        strategy: "native",
        runtime: "opencode",
        version: "1.14.19",
        sessionId: "session-1",
      });

      await expect(
        run.prompt({ text: "second", schema: { type: "object" } }),
      ).resolves.toMatchObject({
        text: '{"result":"recovered"}',
        structured: undefined,
      });

      const prompts = fake.requests.filter(({ path }) =>
        /\/session\/session-1\/message$/.test(path),
      );
      expect(prompts).toHaveLength(2);
      expect(JSON.parse(prompts[0]?.body ?? "{}")).toHaveProperty(
        "format.type",
        "json_schema",
      );
      expect(JSON.parse(prompts[1]?.body ?? "{}")).not.toHaveProperty("format");
    } finally {
      await closeServer(fake.server);
    }
  });

  it("uses prompt mode before the first request for an affected version", async () => {
    const fake = await startServer({
      version: "1.17.13",
      promptResponses: [textPromptResponse("session-1", '{"ok":true}')],
    });
    try {
      const run = await createOpenCodeRun({ url: fake.url });
      await expect(
        run.prompt({ text: "use prompt mode", schema: { type: "object" } }),
      ).resolves.toMatchObject({ text: '{"ok":true}' });

      const prompt = fake.requests.find(({ path }) =>
        /\/session\/session-1\/message$/.test(path),
      );
      expect(JSON.parse(prompt?.body ?? "{}")).not.toHaveProperty("format");
    } finally {
      await closeServer(fake.server);
    }
  });

  it("sends the pinned model and reasoning on the first prompt", async () => {
    const fake = await startServer();
    try {
      const run = await createOpenCodeRun({ url: fake.url }, undefined, {
        model: { provider: "openai", model: "gpt-5.6-luna" },
        reasoning: "high",
      });

      await run.prompt({ text: "use the selected model", schema: {} });

      expect(
        fake.requests.find(({ path }) => path === "/session/session-1/message"),
      ).toMatchObject({
        body: expect.stringContaining(
          '"model":{"providerID":"openai","modelID":"gpt-5.6-luna"}',
        ),
      });
      expect(
        fake.requests.find(({ path }) => path === "/session/session-1/message"),
      ).toMatchObject({ body: expect.stringContaining('"variant":"high"') });
    } finally {
      await closeServer(fake.server);
    }
  });

  it("forks a new session from the terminal prompt checkpoint", async () => {
    const fake = await startServer();
    try {
      const run = await createOpenCodeRun({ url: fake.url });
      await run.prompt({ text: "source", schema: { type: "object" } });
      const branch = await run.fork(await run.checkpoint());
      await branch.prompt({ text: "branch", schema: { type: "object" } });

      expect(
        fake.requests
          .filter(({ path }) => !isInteractionMonitorPath(path))
          .map(({ path }) => path),
      ).toEqual([
        "/session",
        "/session/session-1/message",
        "/session/session-1/fork",
        "/session/session-2/message",
      ]);
      expect(
        fake.requests.find(({ path }) => path === "/session/session-1/fork"),
      ).toMatchObject({ body: '{"messageID":"message-session-1"}' });
    } finally {
      await closeServer(fake.server);
    }
  });

  it("initializes a forked model before sending its first prompt", async () => {
    const fake = await startServer();
    try {
      const run = await createOpenCodeRun({ url: fake.url });
      await run.prompt({ text: "source", schema: { type: "object" } });
      const branch = await run.fork(await run.checkpoint(), {
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
        reasoning: "high",
      });
      await branch.prompt({ text: "branch", schema: { type: "object" } });

      expect(
        fake.requests
          .filter(({ path }) => !isInteractionMonitorPath(path))
          .map(({ path }) => path),
      ).toEqual([
        "/session",
        "/session/session-1/message",
        "/session/session-1/fork",
        "/session/session-2/init",
        "/session/session-2/message",
      ]);
      expect(
        fake.requests.find(({ path }) => path === "/session/session-2/init"),
      ).toMatchObject({
        body: JSON.stringify({
          modelID: "claude-sonnet-4-6",
          providerID: "anthropic",
          messageID: "message-session-1",
        }),
      });
      expect(
        fake.requests.find(({ path }) => path === "/session/session-2/message"),
      ).toMatchObject({ body: expect.stringContaining('"variant":"high"') });
    } finally {
      await closeServer(fake.server);
    }
  });

  it("does not expose a forked run when model initialization fails", async () => {
    const fake = await startServer({ failInit: true });
    try {
      const run = await createOpenCodeRun({ url: fake.url });
      await run.prompt({ text: "source", schema: { type: "object" } });

      await expect(
        run.fork(await run.checkpoint(), {
          model: { provider: "anthropic", model: "claude-sonnet-4-6" },
          reasoning: "high",
        }),
      ).rejects.toThrow(/native session checkpoint fork failed/i);

      expect(
        fake.requests
          .filter(({ path }) => !isInteractionMonitorPath(path))
          .map(({ path }) => path),
      ).toEqual([
        "/session",
        "/session/session-1/message",
        "/session/session-1/fork",
        "/session/session-2/init",
      ]);
    } finally {
      await closeServer(fake.server);
    }
  });

  it("does not submit a second prompt while the first prompt is pending", async () => {
    const fake = await startServer({ holdPrompt: true });
    try {
      const run = await createOpenCodeRun({ url: fake.url });
      const first = run.prompt({ text: "first", schema: { type: "object" } });
      await fake.waitForPromptCount(1);

      const second = run.prompt({
        text: "second",
        schema: { type: "object" },
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25);
      });

      expect(fake.promptCount()).toBe(1);

      fake.completeNextPrompt();
      await first;
      await fake.waitForPromptCount(2);

      fake.completeNextPrompt();
      await second;
    } finally {
      await closeServer(fake.server);
    }
  });

  it("forwards tool lifecycle events from the session stream", async () => {
    const fake = await startServer({ toolEvents: true });
    try {
      const run = await createOpenCodeRun({ url: fake.url });
      const activities: OpenCodeActivity[] = [];

      await expect(
        run.prompt({
          text: "inspect the repository",
          schema: { type: "object" },
          onActivity: (activity) => activities.push(activity),
        }),
      ).resolves.toMatchObject({ structured: { session: "session-1" } });

      expect(activities).toEqual([
        {
          activityId: "call-1",
          kind: "tool",
          name: "filesystem.read",
          state: "started",
          input: { path: "/repo/package.json" },
        },
        {
          activityId: "call-1",
          kind: "tool",
          name: "filesystem.read",
          state: "succeeded",
          output: "12 bytes",
        },
      ]);
    } finally {
      await closeServer(fake.server);
    }
  });

  it("reports uncertain termination for a mutating background shell command", async () => {
    const fake = await startServer({
      backgroundShellEvent: true,
      holdPrompt: true,
    });
    try {
      const run = await createOpenCodeRun({ url: fake.url });
      let reportUncertainActivity!: (value: unknown) => void;
      const uncertainActivity = new Promise<unknown>((resolve) => {
        reportUncertainActivity = resolve;
      });

      const prompt = run.prompt({
        text: "format the workspace",
        schema: { type: "object" },
        onUncertainActivity: reportUncertainActivity,
      });
      await fake.promptStarted;

      await expect(uncertainActivity).resolves.toEqual({
        reason: "disconnect",
      });
      fake.completeNextPrompt();
      await prompt;
    } finally {
      await closeServer(fake.server);
    }
  });

  it("retains tool names for next tool lifecycle events without names", async () => {
    const fake = await startServer({ nextToolEvents: true });
    try {
      const run = await createOpenCodeRun({ url: fake.url });
      const activities: OpenCodeActivity[] = [];

      await run.prompt({
        text: "inspect the repository",
        schema: { type: "object" },
        onActivity: (activity) => activities.push(activity),
      });

      expect(activities).toEqual([
        expect.objectContaining({
          activityId: "call-next-1",
          name: "filesystem.read",
          state: "started",
          input: { path: "/repo/package.json" },
        }),
        expect.objectContaining({
          activityId: "call-next-1",
          name: "filesystem.read",
          state: "progress",
          output: { bytes: 12 },
        }),
        expect.objectContaining({
          activityId: "call-next-1",
          name: "filesystem.read",
          state: "succeeded",
          output: { bytes: 12 },
        }),
      ]);
    } finally {
      await closeServer(fake.server);
    }
  });

  it("normalizes skill tool events with metadata and timing", async () => {
    const fake = await startServer({ skillEvents: true });
    try {
      const run = await createOpenCodeRun({ url: fake.url });
      const activities: OpenCodeActivity[] = [];

      await run.prompt({
        text: "use the skill",
        schema: { type: "object" },
        onActivity: (activity) => activities.push(activity),
      });

      expect(activities).toEqual([
        {
          activityId: "skill-call-1",
          kind: "skill",
          name: "web-perf",
          state: "started",
          input: { name: "web-perf" },
          metadata: {
            name: "web-perf",
            dir: "/repo/.agents/skills/web-perf",
          },
          startedAt: 100,
        },
        {
          activityId: "skill-call-1",
          kind: "skill",
          name: "web-perf",
          state: "succeeded",
          input: { name: "web-perf" },
          output: "Loaded skill instructions",
          metadata: {
            name: "web-perf",
            dir: "/repo/.agents/skills/web-perf",
          },
          startedAt: 100,
          endedAt: 125,
        },
      ]);
    } finally {
      await closeServer(fake.server);
    }
  });

  it("does not reuse session state across Runs and abort is idempotent", async () => {
    const fake = await startServer();
    try {
      const first = await createOpenCodeRun({ url: fake.url });
      const second = await createOpenCodeRun({ url: fake.url });

      await expect(
        first.prompt({ text: "first", schema: {} }),
      ).resolves.toEqual({
        structured: { session: "session-1" },
        observation: expect.objectContaining({
          sessionID: "session-1",
          messageID: "message-session-1",
        }),
        metrics: {
          durationMs: 1,
          model: "fake-model",
          provider: "fake-provider",
          cost: 0,
          tokens: {
            total: 0,
            input: 0,
            output: 0,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
      });
      await expect(
        second.prompt({ text: "second", schema: {} }),
      ).resolves.toEqual({
        structured: { session: "session-2" },
        observation: expect.objectContaining({
          sessionID: "session-2",
          messageID: "message-session-2",
        }),
        metrics: {
          durationMs: 1,
          model: "fake-model",
          provider: "fake-provider",
          cost: 0,
          tokens: {
            total: 0,
            input: 0,
            output: 0,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
      });
      await Promise.all([first.abort(), first.abort()]);

      expect(
        fake.requests
          .filter(({ path }) => !isInteractionMonitorPath(path))
          .map(({ path }) => path),
      ).toEqual([
        "/session",
        "/session",
        "/session/session-1/message",
        "/session/session-2/message",
        "/session/session-1/abort",
      ]);
    } finally {
      await closeServer(fake.server);
    }
  });

  it("fails before session creation when already cancelled", async () => {
    const fake = await startServer();
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(
        createOpenCodeRun({ url: fake.url }, controller.signal),
      ).rejects.toThrow("cancelled before session creation");
      expect(fake.requests).toEqual([]);
    } finally {
      await closeServer(fake.server);
    }
  });

  it("cancels an in-flight session creation before any task prompt", async () => {
    const fake = await startServer({ holdSession: true });
    try {
      const controller = new AbortController();
      const pending = createOpenCodeRun({ url: fake.url }, controller.signal);
      await fake.sessionStarted;
      controller.abort();

      await expect(pending).rejects.toThrow(
        "could not create an external session",
      );
      expect(fake.requests.map(({ path }) => path)).toEqual(["/session"]);
    } finally {
      await closeServer(fake.server);
    }
  });

  it("maps an unreachable endpoint to an executor failure", async () => {
    await expect(
      createOpenCodeRun({ url: "http://127.0.0.1:1" }),
    ).rejects.toThrow("could not create an external session");
  });

  it("reports a failed prompt submission as an uncertain disconnect", async () => {
    const fake = await startServer({ failPrompt: true });
    try {
      const run = await createOpenCodeRun({ url: fake.url });
      const uncertainActivities: unknown[] = [];

      await expect(
        run.prompt({
          text: "inspect the repository",
          schema: { type: "object" },
          onUncertainActivity: (activity) => uncertainActivities.push(activity),
        }),
      ).rejects.toThrow("structured task request failed");

      expect(uncertainActivities).toEqual([{ reason: "disconnect" }]);
    } finally {
      await closeServer(fake.server);
    }
  });

  it.each([
    ["PermissionRequired", "user-input"],
    ["QuestionRequired", "user-input"],
    ["ConfirmationRequired", "confirmation"],
    ["OptionSelectionRequired", "option-selection"],
  ] as const)(
    "rejects %s without using response APIs",
    async (interaction, requirement) => {
      const fake = await startServer({ interaction });
      try {
        const run = await createOpenCodeRun({ url: fake.url });
        const error = await run
          .prompt({ text: "needs approval", schema: { type: "object" } })
          .catch((cause: unknown) => cause);

        expect(error).toMatchObject({
          name: "InteractionRequiredError",
          requirement,
          message: "Seqlane execution requires human interaction",
        });
        expect(error).not.toHaveProperty("rawRequest");
        expect(
          fake.requests
            .filter(({ path }) => !isInteractionMonitorPath(path))
            .map(({ path }) => path),
        ).toEqual(["/session", "/session/session-1/message"]);
        expect(
          fake.requests.some(({ path }) =>
            /permission\/.*\/reply|question|tui|response/i.test(path),
          ),
        ).toBe(false);
      } finally {
        await closeServer(fake.server);
      }
    },
  );

  it("fails a prompt that remains pending on an OpenCode permission request", async () => {
    const fake = await startServer({
      holdPrompt: true,
    });
    let run: Awaited<ReturnType<typeof createOpenCodeRun>> | undefined;
    try {
      run = await createOpenCodeRun({ url: fake.url });
      let invalidated = 0;
      const pending = run.prompt({
        text: "needs filesystem access",
        schema: { type: "object" },
        onRunInvalidated: () => {
          invalidated += 1;
        },
      });
      await fake.promptStarted;
      await fake.eventStarted;
      fake.publishPermission();

      await expect(
        Promise.race([
          pending,
          new Promise((_, reject) => {
            setTimeout(
              () => reject(new Error("prompt did not fail for permission")),
              250,
            );
          }),
        ]),
      ).rejects.toMatchObject({
        name: "InteractionRequiredError",
        requirement: "user-input",
        message: "Seqlane execution requires human interaction",
      });
      expect(invalidated).toBe(1);
      expect(fake.requests.some(({ path }) => path === "/event")).toBe(true);
      expect(
        fake.requests.some(({ path }) => /permission.*reply/i.test(path)),
      ).toBe(false);
    } finally {
      await run?.abort();
      await closeServer(fake.server);
    }
  });

  it("aborts a pending prompt when permission monitoring fails", async () => {
    const fake = await startServer({ holdPrompt: true });
    let run: Awaited<ReturnType<typeof createOpenCodeRun>> | undefined;
    try {
      run = await createOpenCodeRun({ url: fake.url });
      let invalidated = 0;
      const pending = run.prompt({
        text: "needs filesystem access",
        schema: { type: "object" },
        onRunInvalidated: () => {
          invalidated += 1;
        },
      });
      await fake.promptStarted;
      await fake.eventStarted;
      fake.closePermissionEvents();

      await expect(pending).rejects.toThrow(
        "OpenCode executor: could not monitor external interaction requirements",
      );
      expect(
        fake.requests.some(({ path }) => path === "/session/session-1/abort"),
      ).toBe(true);
      expect(invalidated).toBe(1);
    } finally {
      await run?.abort().catch(() => undefined);
      await closeServer(fake.server);
    }
  });

  it("does not abort a shared session after event subscription setup fails", async () => {
    const abort = vi.fn(async () => undefined);
    vi.resetModules();
    vi.doMock("./transport.js", () => ({
      createOpenCodeTransport: () => ({
        createSession: async () => ({
          sessionId: "session-1",
          directory: "/repo",
        }),
        subscribeEvents: async () => {
          throw new Error("event connection failed");
        },
        hasPendingPermission: async () => false,
        prompt: async () => promptResponse("session-1"),
        abort,
      }),
    }));

    try {
      const { createOpenCodeRun: createMockedRun } =
        await import("./session.js");
      const run = await createMockedRun({ url: "http://opencode.test" });
      const controller = new AbortController();

      await expect(
        run.prompt({
          text: "inspect this change",
          schema: { type: "object" },
          signal: controller.signal,
        }),
      ).rejects.toThrow(
        "OpenCode executor: could not monitor external interaction requirements",
      );

      controller.abort();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(abort).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("./transport.js");
      vi.resetModules();
    }
  });

  it("waits for OpenCode to acknowledge abort before ending a cancelled prompt", async () => {
    const fake = await startServer({ holdPrompt: true, holdAbort: true });
    try {
      const run = await createOpenCodeRun({ url: fake.url });
      const controller = new AbortController();
      const pending = run.prompt({
        text: "cancel me",
        schema: { type: "object" },
        signal: controller.signal,
      });
      await fake.promptStarted;
      controller.abort();
      await fake.abortStarted;

      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 25));

      expect(settled).toBe(false);

      fake.completeNextAbort();

      await expect(pending).rejects.toThrow(
        "run was cancelled during task submission",
      );
      expect(
        fake.requests
          .filter(({ path }) => !isInteractionMonitorPath(path))
          .map(({ path }) => path),
      ).toEqual([
        "/session",
        "/session/session-1/message",
        "/session/session-1/abort",
      ]);
    } finally {
      await closeServer(fake.server);
    }
  });
});
