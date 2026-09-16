import type { ServerResponse } from "node:http";

export interface SessionMonitorFixtureOptions {
  readonly toolEvents?: boolean;
  readonly duplicateToolTerminal?: boolean;
  readonly malformedEventCount?: number;
  readonly nextToolEvents?: boolean;
  readonly skillEvents?: boolean;
  readonly backgroundShellEvent?: boolean;
  readonly eventsEveryPrompt?: boolean;
  readonly historyPageSize?: number;
  readonly repeatHistoryPage?: boolean;
  readonly emptyHistoryContinuation?: boolean;
  readonly oversizedHistoryPage?: boolean;
  readonly stallHistoryAfterPrompt?: boolean;
  readonly promptHistoryEventCount?: number;
  readonly oversizedHistoryEvent?: boolean;
  readonly oversizedPendingRequest?: boolean;
}

function writeJson(response: ServerResponse, value: unknown): void {
  response.writeHead(200, {
    connection: "close",
    "content-type": "application/json",
  });
  response.end(JSON.stringify(value));
}

function legacyToolEvents(options: SessionMonitorFixtureOptions): unknown[] {
  if (!options.toolEvents) return [];
  const terminal = {
    type: "message.part.updated",
    data: {
      sessionID: "session-1",
      part: {
        type: "tool",
        callID: "call-1",
        tool: "filesystem.read",
        state: { status: "completed", output: "12 bytes" },
      },
    },
  };
  return [
    {
      type: "message.part.updated",
      data: {
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
    terminal,
    ...(options.duplicateToolTerminal ? [terminal] : []),
  ];
}

function nextToolEvents(options: SessionMonitorFixtureOptions): unknown[] {
  if (!options.nextToolEvents) return [];
  const common = {
    sessionID: "session-1",
    assistantMessageID: "assistant-session-1",
    callID: "call-next-1",
  };
  return [
    {
      type: "session.next.tool.called",
      data: {
        ...common,
        tool: "filesystem.read",
        input: { path: "/repo/package.json" },
      },
    },
    {
      type: "session.next.tool.progress",
      data: { ...common, structured: { bytes: 12 }, content: [] },
    },
    {
      type: "session.next.tool.success",
      data: {
        ...common,
        structured: { bytes: 12 },
        content: [],
        result: { bytes: 12 },
        provider: { executed: true },
      },
    },
  ];
}

function skillEvents(options: SessionMonitorFixtureOptions): unknown[] {
  if (!options.skillEvents) return [];
  const common = { type: "tool", callID: "skill-call-1", tool: "skill" };
  const metadata = {
    name: "web-perf",
    dir: "/repo/.agents/skills/web-perf",
  };
  return [
    {
      type: "message.part.updated",
      data: {
        sessionID: "session-1",
        part: {
          ...common,
          state: {
            status: "running",
            input: { name: "web-perf" },
            metadata,
            time: { start: 100 },
          },
        },
      },
    },
    {
      type: "message.part.updated",
      data: {
        sessionID: "session-1",
        part: {
          ...common,
          state: {
            status: "completed",
            input: { name: "web-perf" },
            output: "Loaded skill instructions",
            metadata,
            time: { start: 100, end: 125 },
          },
        },
      },
    },
  ];
}

function supplementaryEvents(options: SessionMonitorFixtureOptions): unknown[] {
  const events: unknown[] = [];
  if (options.backgroundShellEvent) {
    events.push({
      type: "session.next.shell.started",
      data: {
        sessionID: "session-1",
        callID: "shell-1",
        command: "pnpm format &",
      },
    });
  }
  for (let index = 0; index < (options.malformedEventCount ?? 0); index += 1) {
    events.push({
      type: "message.updated",
      data: { info: { role: "assistant" } },
    });
  }
  for (
    let index = 0;
    index < (options.promptHistoryEventCount ?? 0);
    index += 1
  ) {
    events.push({
      type: "session.updated",
      data: { sessionID: "session-1", index },
    });
  }
  return events;
}

function configuredPromptEvents(
  options: SessionMonitorFixtureOptions,
): unknown[] {
  return [
    ...legacyToolEvents(options),
    ...nextToolEvents(options),
    ...skillEvents(options),
    ...supplementaryEvents(options),
  ];
}

function historyPage(
  options: SessionMonitorFixtureOptions,
  events: readonly Record<string, unknown>[],
  requestPath: string,
) {
  if (options.emptyHistoryContinuation) return { data: [], hasMore: true };
  if (options.oversizedHistoryEvent) {
    return {
      data: [
        {
          type: "session.updated",
          data: { detail: "x".repeat(300 * 1_024) },
          durable: { aggregateID: "session-1", seq: 1, version: 1 },
        },
      ],
      hasMore: false,
    };
  }
  if (options.oversizedHistoryPage) {
    return {
      data: Array.from({ length: 101 }, (_, index) => ({
        type: "session.updated",
        data: { sessionID: "session-1" },
        durable: {
          aggregateID: "session-1",
          seq: index + 1,
          version: 1,
        },
      })),
      hasMore: false,
    };
  }
  const url = new URL(requestPath, "http://127.0.0.1");
  const after = Number(url.searchParams.get("after") ?? 0);
  const available = options.repeatHistoryPage
    ? events
    : events.filter((event) => {
        const durable = event.durable as { seq?: number } | undefined;
        return (durable?.seq ?? 0) > (Number.isFinite(after) ? after : 0);
      });
  const requestedLimit = Number(url.searchParams.get("limit") ?? 100);
  const pageSize = Math.min(
    options.historyPageSize ?? requestedLimit,
    requestedLimit,
  );
  const data = available.slice(0, pageSize);
  return { data, hasMore: available.length > data.length };
}

function createHistoryFixture(options: SessionMonitorFixtureOptions) {
  const events: Record<string, unknown>[] = [];
  let failed = false;
  let stalled = false;
  return {
    fail(): void {
      failed = true;
    },
    stall(): void {
      stalled = true;
    },
    publish(sessionID: string, values: readonly unknown[]): void {
      for (const value of values) {
        const event = value as Record<string, unknown>;
        const data = event.data as Record<string, unknown> | undefined;
        events.push({
          ...event,
          data: { ...data, sessionID },
          durable: {
            aggregateID: sessionID,
            seq: events.length + 1,
            version: 1,
          },
        });
      }
    },
    respond(requestPath: string, response: ServerResponse): void {
      if (failed) {
        response.writeHead(503);
        response.end("monitor failed");
        return;
      }
      if (stalled) return;
      writeJson(response, historyPage(options, events, requestPath));
    },
  };
}

export function createSessionMonitorFixture(
  options: SessionMonitorFixtureOptions,
) {
  const history = createHistoryFixture(options);
  const promptEvents = configuredPromptEvents(options);
  let pendingPermission = false;
  let resolveMonitorStarted: () => void = () => undefined;
  const monitorStarted = new Promise<void>((resolve) => {
    resolveMonitorStarted = resolve;
  });

  return {
    monitorStarted,
    publishPermission(): void {
      pendingPermission = true;
    },
    fail(): void {
      history.fail();
    },
    publishPromptEvents(sessionID: string, promptCount: number): void {
      if (promptCount === 1 || options.eventsEveryPrompt) {
        history.publish(sessionID, promptEvents);
      }
      if (options.stallHistoryAfterPrompt) history.stall();
    },
    handle(
      method: string | undefined,
      path: string,
      requestPath: string,
      response: ServerResponse,
    ): boolean {
      const historyRequest = /^\/api\/session\/(session-\d+)\/history$/.exec(
        path,
      );
      if (method === "GET" && historyRequest) {
        resolveMonitorStarted();
        history.respond(requestPath, response);
        return true;
      }
      const permission = /^\/api\/session\/(session-\d+)\/permission$/.exec(
        path,
      );
      if (method === "GET" && permission) {
        writeJson(response, {
          data: pendingPermission
            ? [
                {
                  id: "permission-1",
                  sessionID: permission[1],
                  ...(options.oversizedPendingRequest
                    ? { detail: "x".repeat(70 * 1_024) }
                    : {}),
                },
              ]
            : [],
        });
        return true;
      }
      const question = /^\/api\/session\/(session-\d+)\/question$/.exec(path);
      if (method === "GET" && question) {
        writeJson(response, { data: [] });
        return true;
      }
      return false;
    },
  };
}
