// @test-scope ./attempt-transitions.ts
// @test-scope ./prompt-response.ts
import { createServer, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createOpenCodeRun, type OpenCodeActivity } from "./session.js";
import type { OpenCodeEventObservation } from "./observations.js";
import {
  createSessionMonitorFixture,
  type SessionMonitorFixtureOptions,
} from "./session-monitor-fixture.js";

interface RequestLog {
  readonly method: string;
  readonly path: string;
  readonly body?: string;
}

function isInteractionMonitorPath(path: string): boolean {
  return /^\/api\/session\/[^/]+\/(?:history|permission|question)/.test(path);
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

function providerErrorResponse(sessionID: string) {
  const response = promptResponse(sessionID);
  return {
    ...response,
    info: {
      ...response.info,
      structured: undefined,
      error: {
        name: "APIError",
        data: {
          message: "The usage limit has been reached",
          statusCode: 429,
          isRetryable: false,
          responseBody: "private provider response",
        },
      },
    },
  };
}

interface StartServerOptions extends SessionMonitorFixtureOptions {
  readonly interaction?: boolean | string;
  readonly failPrompt?: boolean;
  readonly failInit?: boolean;
  readonly holdPrompt?: boolean;
  readonly holdAbort?: boolean;
  readonly holdSession?: boolean;
  readonly readbackCompatibilityError?: boolean;
  readonly version?: string;
  readonly promptResponses?: readonly unknown[];
  readonly messageLists?: readonly (readonly unknown[])[];
  readonly readbackFailures?: number;
}

async function startServer(options: StartServerOptions = {}) {
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
  const monitor = createSessionMonitorFixture(options);
  let resolveSessionStarted: () => void = () => undefined;
  const sessionStarted = new Promise<void>((resolve) => {
    resolveSessionStarted = resolve;
  });
  let promptCount = 0;
  let messageListCount = 0;
  const messageListQueries: string[] = [];
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

    if (monitor.handle(request.method, path, requestPath, response)) return;

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

    const match = /^(?:\/api)?\/session\/(session-\d+)\/message$/.exec(path);
    if (request.method === "GET" && match) {
      messageListQueries.push(requestPath);
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
      const messages =
        options.messageLists === undefined
          ? [promptResponse(match[1] ?? "session-1")]
          : (options.messageLists[
              Math.min(messageListCount, options.messageLists.length - 1)
            ] ?? []);
      messageListCount += 1;
      if (path.startsWith("/api/")) {
        writeJson(response, { data: messages, cursor: {} });
      } else {
        writeJson(response, messages);
      }
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
      monitor.publishPromptEvents(sessionID, promptCount);
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
    monitorStarted: monitor.monitorStarted,
    publishPermission() {
      monitor.publishPermission();
    },
    closePermissionEvents() {
      monitor.fail();
    },
    promptStarted,
    promptCount: () => promptCount,
    messageListCount: () => messageListCount,
    messageListQueries: () => [...messageListQueries],
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
  it("does not open the leaking event stream for sequential prompts", async () => {
    const fake = await startServer({
      toolEvents: true,
      eventsEveryPrompt: true,
    });
    try {
      const run = await createOpenCodeRun({ url: fake.url });
      const activities: OpenCodeActivity[] = [];
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await run.prompt({
          text: `inspect ${attempt}`,
          schema: {},
          onActivity: (activity) => activities.push(activity),
        });
      }
      expect(fake.requests.some(({ path }) => path === "/event")).toBe(false);
      expect(
        fake.requests.filter(({ path }) => /\/history(?:\?|$)/.test(path)),
      ).toHaveLength(25);
      expect(activities).toHaveLength(24);
      await run.close();
      await run.close();
      await expect(
        run.prompt({ text: "too late", schema: {} }),
      ).rejects.toThrow("run is closed");
    } finally {
      await closeServer(fake.server);
    }
  });

  it("drains every final history page before completing a prompt", async () => {
    const fake = await startServer({ toolEvents: true, historyPageSize: 1 });
    try {
      const run = await createOpenCodeRun({ url: fake.url });
      const activities: OpenCodeActivity[] = [];

      await run.prompt({
        text: "inspect",
        schema: {},
        onActivity: (activity) => activities.push(activity),
      });

      expect(activities).toHaveLength(2);
      expect(
        fake.requests.filter(({ path }) => /\/history(?:\?|$)/.test(path)),
      ).toHaveLength(4);
    } finally {
      await closeServer(fake.server);
    }
  });

  it("reads prompt-mode tool parts when history has no activity event", async () => {
    const response = promptResponse("session-1", undefined);
    const toolPart = {
      id: "part-1",
      sessionID: "session-1",
      messageID: "message-session-1",
      type: "tool",
      callID: "call-1",
      tool: "filesystem.read",
      state: {
        status: "completed",
        input: { path: "/repo/package.json" },
        output: "{}",
        metadata: { source: "message-list" },
        time: { start: 1, end: 2 },
      },
    };
    const fake = await startServer({
      messageLists: [
        [],
        [{ info: response.info, parts: [toolPart] }],
        [{ info: response.info, parts: [toolPart] }],
      ],
      promptResponses: [
        textPromptResponse("session-1", "{}"),
        textPromptResponse("session-1", "{}"),
      ],
    });
    try {
      const run = await createOpenCodeRun({ url: fake.url });
      const activities: OpenCodeActivity[] = [];
      const diagnostics: string[] = [];
      const observations: unknown[] = [];

      await run.prompt({
        text: "inspect",
        schema: {},
        strategy: "prompt",
        onActivity: (activity) => activities.push(activity),
        onObservation: (observation) => observations.push(observation),
        onDiagnostic: (message) => diagnostics.push(message),
      });
      await run.prompt({
        text: "inspect again",
        schema: {},
        strategy: "prompt",
        onActivity: (activity) => activities.push(activity),
        onObservation: (observation) => observations.push(observation),
        onDiagnostic: (message) => diagnostics.push(message),
      });

      expect({
        activities,
        observations,
        diagnostics,
        messageListCount: fake.messageListCount(),
        messageListQueries: fake.messageListQueries(),
      }).toEqual({
        activities: [
          expect.objectContaining({
            activityId: "call-1",
            name: "filesystem.read",
            state: "succeeded",
            input: { path: "/repo/package.json" },
            output: "{}",
          }),
        ],
        observations: [expect.objectContaining({ callID: "call-1" })],
        diagnostics: [],
        messageListCount: 3,
        messageListQueries: [
          "/session/session-1/message?limit=100",
          "/session/session-1/message?limit=100",
          "/session/session-1/message?limit=100",
        ],
      });
    } finally {
      await closeServer(fake.server);
    }
  });

  it("dispatches fallback tool activity after an initial history snapshot failure", async () => {
    const response = textPromptResponse("session-1", "{}");
    const toolPart = {
      id: "part-1",
      sessionID: "session-1",
      messageID: "message-session-1",
      type: "tool",
      callID: "call-1",
      tool: "filesystem.read",
      state: {
        status: "completed",
        input: { path: "/repo/package.json" },
        output: "{}",
        metadata: { source: "message-list" },
        time: { start: 1, end: 2 },
      },
    };
    const fake = await startServer({
      readbackFailures: 1,
      messageLists: [[{ info: response.info, parts: [toolPart] }]],
      promptResponses: [response],
    });
    try {
      const run = await createOpenCodeRun({ url: fake.url });
      const activities: OpenCodeActivity[] = [];

      await run.prompt({
        text: "inspect",
        schema: {},
        strategy: "prompt",
        onActivity: (activity) => activities.push(activity),
      });

      expect(activities).toEqual([
        expect.objectContaining({
          activityId: "call-1",
          name: "filesystem.read",
          state: "succeeded",
        }),
      ]);
    } finally {
      await closeServer(fake.server);
    }
  });

  it("aborts active prompt work before closing a run", async () => {
    const fake = await startServer({ holdPrompt: true });
    try {
      const run = await createOpenCodeRun({ url: fake.url });
      const prompt = run.prompt({ text: "wait", schema: {} });
      await fake.promptStarted;

      await expect(run.close()).resolves.toBeUndefined();
      await expect(prompt).rejects.toThrow();
      expect(
        fake.requests.some(
          ({ method, path }) =>
            method === "POST" && path === "/session/session-1/abort",
        ),
      ).toBe(true);
    } finally {
      await closeServer(fake.server);
    }
  });

  it("bounds a stalled final history read", async () => {
    const fake = await startServer({ stallHistoryAfterPrompt: true });
    try {
      const run = await createOpenCodeRun({ url: fake.url });
      const started = Date.now();

      await run.prompt({ text: "finish", schema: {} });

      expect(Date.now() - started).toBeLessThan(1_500);
      await run.close();
    } finally {
      await closeServer(fake.server);
    }
  });

  it.each([
    [
      "empty continuation pages",
      { emptyHistoryContinuation: true },
      "empty continuation page",
    ],
    [
      "repeated durable events",
      { toolEvents: true, historyPageSize: 1, repeatHistoryPage: true },
      "did not advance its durable cursor",
    ],
    [
      "oversized pages",
      { oversizedHistoryPage: true },
      "invalid or oversized page",
    ],
    [
      "oversized history events",
      { oversizedHistoryEvent: true },
      "exceeded 262144 bytes",
    ],
    [
      "excessive page counts",
      { promptHistoryEventCount: 1_001 },
      "exceeded 10 pages",
    ],
  ] as const)("rejects %s", async (_name, options, expectedCause) => {
    const fake = await startServer(options);
    try {
      const run = await createOpenCodeRun({ url: fake.url });
      await expect(
        run.prompt({ text: "inspect", schema: {} }),
      ).rejects.toMatchObject({
        cause: expect.objectContaining({
          message: expect.stringContaining(expectedCause),
        }),
      });
    } finally {
      await closeServer(fake.server);
    }
  });

  it("rejects oversized pending-request records", async () => {
    const fake = await startServer({
      holdPrompt: true,
      oversizedPendingRequest: true,
    });
    try {
      const run = await createOpenCodeRun({ url: fake.url });
      const prompt = run.prompt({ text: "inspect", schema: {} });
      await fake.promptStarted;
      await fake.monitorStarted;
      fake.publishPermission();

      await expect(prompt).rejects.toMatchObject({
        cause: expect.objectContaining({
          message: expect.stringContaining(
            "invalid or oversized pending requests",
          ),
        }),
      });
    } finally {
      await closeServer(fake.server);
    }
  });

  it("backs off finite monitor requests while a prompt is idle", async () => {
    const fake = await startServer({ holdPrompt: true });
    try {
      const run = await createOpenCodeRun({ url: fake.url });
      const prompt = run.prompt({ text: "wait", schema: {} });
      await fake.promptStarted;
      await new Promise((resolve) => setTimeout(resolve, 900));

      const monitorRequestCount = fake.requests.filter(({ path }) =>
        isInteractionMonitorPath(path),
      ).length;
      expect(monitorRequestCount).toBeGreaterThanOrEqual(7);
      expect(monitorRequestCount).toBeLessThanOrEqual(10);
      await run.abort();
      await expect(prompt).rejects.toThrow();
    } finally {
      await closeServer(fake.server);
    }
  });

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
      const observations: OpenCodeEventObservation[] = [];

      await expect(
        run.prompt({
          text: "inspect the repository",
          schema: { type: "object" },
          onActivity: (activity) => activities.push(activity),
          onObservation: (observation) => observations.push(observation),
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
      expect(observations).toEqual([
        {
          kind: "tool",
          sessionID: "session-1",
          messageID: "call-1",
          callID: "call-1",
          tool: "filesystem.read",
          status: "running",
        },
        {
          kind: "tool",
          sessionID: "session-1",
          messageID: "call-1",
          callID: "call-1",
          tool: "filesystem.read",
          status: "completed",
        },
      ]);
    } finally {
      await closeServer(fake.server);
    }
  });

  it("does not fan out duplicate terminal activity transitions", async () => {
    const fake = await startServer({
      toolEvents: true,
      duplicateToolTerminal: true,
    });
    try {
      const run = await createOpenCodeRun({ url: fake.url });
      const activities: OpenCodeActivity[] = [];

      await run.prompt({
        text: "inspect the repository",
        schema: { type: "object" },
        onActivity: (activity) => activities.push(activity),
      });

      expect(activities).toHaveLength(2);
    } finally {
      await closeServer(fake.server);
    }
  });

  it("bounds malformed and unsupported event diagnostics", async () => {
    const fake = await startServer({ malformedEventCount: 100 });
    try {
      const run = await createOpenCodeRun({ url: fake.url });
      const diagnostics: string[] = [];

      await run.prompt({
        text: "ignore malformed events",
        schema: { type: "object" },
        onDiagnostic: (message) => diagnostics.push(message),
      });

      expect(diagnostics.length).toBeLessThanOrEqual(9);
      expect(diagnostics.at(-1)).toContain("suppressed");
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
      const observations: OpenCodeEventObservation[] = [];

      await run.prompt({
        text: "inspect the repository",
        schema: { type: "object" },
        onActivity: (activity) => activities.push(activity),
        onObservation: (observation) => observations.push(observation),
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
      expect(observations).toEqual([
        expect.objectContaining({
          messageID: "assistant-session-1",
          callID: "call-next-1",
          status: "running",
        }),
        expect.objectContaining({
          messageID: "assistant-session-1",
          callID: "call-next-1",
          status: "running",
        }),
        expect.objectContaining({
          messageID: "assistant-session-1",
          callID: "call-next-1",
          status: "completed",
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

  it("surfaces a safe provider rate or usage limit failure", async () => {
    const fake = await startServer({
      promptResponses: [providerErrorResponse("session-1")],
    });
    try {
      const run = await createOpenCodeRun({ url: fake.url });

      await expect(
        run.prompt({
          text: "inspect the repository",
          schema: { type: "object" },
        }),
      ).rejects.toMatchObject({
        name: "OpenCodeProviderApiError",
        message:
          "OpenCode executor: provider rejected the request because the rate or usage limit was reached (HTTP 429)",
        statusCode: 429,
        retryable: false,
        cause: {
          name: "APIError",
          data: { statusCode: 429, isRetryable: false },
        },
      });
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
          fake.requests
            .filter(({ path }) => !isInteractionMonitorPath(path))
            .some(({ path }) =>
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
      await fake.monitorStarted;
      fake.publishPermission();

      await expect(
        Promise.race([
          pending,
          new Promise((_, reject) => {
            setTimeout(
              () => reject(new Error("prompt did not fail for permission")),
              1_500,
            );
          }),
        ]),
      ).rejects.toMatchObject({
        name: "InteractionRequiredError",
        requirement: "user-input",
        message: "Seqlane execution requires human interaction",
      });
      expect(invalidated).toBe(1);
      expect(
        fake.requests.some(({ path }) => /\/history(?:\?|$)/.test(path)),
      ).toBe(true);
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
      await fake.monitorStarted;
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

  it("does not abort a shared session after monitor setup fails", async () => {
    const abort = vi.fn(async () => undefined);
    vi.resetModules();
    vi.doMock("./transport.js", () => ({
      createOpenCodeTransport: () => ({
        createSession: async () => ({
          sessionId: "session-1",
          directory: "/repo",
        }),
        monitorSession: async () => {
          throw new Error("session monitor failed");
        },
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

  it("waits for session monitor cleanup before completing a prompt", async () => {
    let releaseCleanup!: () => void;
    const cleanupReleased = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let reportCleanupStarted!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => {
      reportCleanupStarted = resolve;
    });
    vi.resetModules();
    vi.doMock("./transport.js", () => ({
      createOpenCodeTransport: () => ({
        createSession: async () => ({
          sessionId: "session-1",
          directory: "/repo",
        }),
        getRuntimeVersion: async () => "1.18.27",
        monitorSession: async (_sessionId: string, signal: AbortSignal) => ({
          async *[Symbol.asyncIterator]() {
            yield { type: "server.connected", properties: {} };
            try {
              await new Promise<void>((resolve) =>
                signal.addEventListener("abort", () => resolve(), {
                  once: true,
                }),
              );
            } finally {
              reportCleanupStarted();
              await cleanupReleased;
            }
          },
        }),
        prompt: async () => promptResponse("session-1"),
        abort: async () => undefined,
      }),
    }));

    try {
      const { createOpenCodeRun: createMockedRun } =
        await import("./session.js");
      const run = await createMockedRun({
        url: "http://opencode.test",
        structuredOutput: { strategy: "native" },
      });
      const pending = run.prompt({ text: "inspect", schema: {} });
      await cleanupStarted;

      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);

      releaseCleanup();
      await expect(pending).resolves.toMatchObject({
        structured: { session: "session-1" },
      });
    } finally {
      releaseCleanup();
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
