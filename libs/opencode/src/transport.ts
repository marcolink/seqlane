import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import type { ModelSelection } from "@seqlane/core";
import { z } from "zod";
import { createOpenCodeClient } from "./client.js";
import { OpenCodeExecutorError } from "./errors.js";
import type { OpenCodePrompt } from "./protocol.js";
const sessionSchema = z.looseObject({
  id: z.string().min(1),
  directory: z.string().min(1),
});

export interface OpenCodeSession {
  readonly sessionId: string;
  readonly directory: string;
  readonly workspace?: string;
}

/** Private adapter configuration for a pinned Seqlane model selection. */
export interface OpenCodeSessionConfiguration {
  readonly messageId: string;
  readonly selection: ModelSelection;
}

export interface OpenCodeTransport {
  createSession(
    workspace: string | undefined,
    signal?: AbortSignal,
  ): Promise<OpenCodeSession>;
  forkSession(
    sessionId: string,
    messageId: string,
    signal?: AbortSignal,
  ): Promise<OpenCodeSession>;
  configureSession(
    sessionId: string,
    configuration: OpenCodeSessionConfiguration,
    signal?: AbortSignal,
  ): Promise<void>;
  prompt(
    sessionId: string,
    request: OpenCodePrompt,
    signal?: AbortSignal,
  ): Promise<unknown>;
  readonly getRuntimeVersion?: (
    signal?: AbortSignal,
  ) => Promise<string | undefined>;
  readonly listMessages?: (
    sessionId: string,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  /** Uses finite session reads. Do not implement this with OpenCode's `/event`. */
  monitorSession(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<AsyncIterable<unknown>>;
  abort(sessionId: string, signal?: AbortSignal): Promise<void>;
}

const historyPageLimit = 100;
const maxHistoryPagesPerCycle = 10;
const maxHistoryBaselinePages = 100;
const initialPollDelayMs = 250;
const maxPollDelayMs = 1_000;
const finalPollTimeoutMs = 1_000;
const maxMonitorValueDepth = 12;
const maxMonitorCollectionEntries = 100;
const maxMonitorStringLength = 64 * 1_024;
const maxMonitorPropertyNameLength = 256;

function boundedMonitorValueSchema(depth: number): z.ZodType<unknown> {
  const scalar = z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string().max(maxMonitorStringLength),
  ]);
  if (depth === 0) return scalar;
  const value = boundedMonitorValueSchema(depth - 1);
  const record = z
    .record(z.string().max(maxMonitorPropertyNameLength), value)
    .superRefine((entry, context) => {
      if (Object.keys(entry).length > maxMonitorCollectionEntries) {
        context.addIssue({
          code: "too_big",
          maximum: maxMonitorCollectionEntries,
          origin: "object",
          inclusive: true,
          message: "Monitor object has too many properties",
        });
      }
    });
  return z.union([
    scalar,
    z.array(value).max(maxMonitorCollectionEntries),
    record,
  ]);
}

const boundedMonitorRecordSchema = z
  .record(
    z.string().max(maxMonitorPropertyNameLength),
    boundedMonitorValueSchema(maxMonitorValueDepth),
  )
  .superRefine((entry, context) => {
    if (Object.keys(entry).length > maxMonitorCollectionEntries) {
      context.addIssue({
        code: "too_big",
        maximum: maxMonitorCollectionEntries,
        origin: "object",
        inclusive: true,
        message: "Monitor record has too many properties",
      });
    }
  });

const eventPageSchema = z.object({
  data: z.array(boundedMonitorRecordSchema).max(historyPageLimit),
  hasMore: z.boolean(),
});

const pendingRequestsSchema = z.object({
  data: z.array(boundedMonitorRecordSchema).max(historyPageLimit),
});

const durableEventSchema = z.object({
  durable: z.object({ seq: z.number().int().nonnegative() }),
});

interface SessionMonitorState {
  after?: number;
  initialized: boolean;
}

interface HistoryDrainOptions {
  readonly collect: boolean;
  readonly maxPages: number;
}

async function readHistoryPage(
  client: OpencodeClient,
  sessionId: string,
  after: number | undefined,
  signal: AbortSignal,
) {
  const response = await client.v2.session.history(
    {
      sessionID: sessionId,
      limit: historyPageLimit,
      ...(after === undefined ? {} : { after }),
    },
    { throwOnError: true, signal },
  );
  const page = eventPageSchema.safeParse(response.data);
  if (!page.success) {
    throw new OpenCodeExecutorError(
      "OpenCode session history returned an invalid or oversized page",
      page.error,
    );
  }
  return page.data;
}

function durableSequence(event: unknown, cursor: number | undefined): number {
  const parsed = durableEventSchema.safeParse(event);
  if (!parsed.success) {
    throw new OpenCodeExecutorError(
      "OpenCode session history returned an invalid durable event",
      parsed.error,
    );
  }
  const sequence = parsed.data.durable.seq;
  if (sequence <= (cursor ?? -1)) {
    throw new OpenCodeExecutorError(
      "OpenCode session history did not advance its durable cursor",
    );
  }
  return sequence;
}

async function drainSessionHistory(
  client: OpencodeClient,
  sessionId: string,
  state: SessionMonitorState,
  signal: AbortSignal,
  options: HistoryDrainOptions,
): Promise<unknown[]> {
  const events: unknown[] = [];
  let cursor = state.after;
  for (let pageIndex = 0; pageIndex < options.maxPages; pageIndex += 1) {
    const page = await readHistoryPage(client, sessionId, cursor, signal);
    for (const event of page.data) {
      cursor = durableSequence(event, cursor);
      if (options.collect) events.push(event);
    }
    if (!page.hasMore) {
      state.after = cursor;
      return events;
    }
    if (page.data.length === 0) {
      throw new OpenCodeExecutorError(
        "OpenCode session history returned an empty continuation page",
      );
    }
  }
  throw new OpenCodeExecutorError(
    `OpenCode session history exceeded ${options.maxPages} pages`,
  );
}

async function readPendingRequests(
  client: OpencodeClient,
  sessionId: string,
  signal: AbortSignal,
) {
  const requestOptions = { throwOnError: true as const, signal };
  const [permissionResponse, questionResponse] = await Promise.all([
    client.v2.session.permission.list({ sessionID: sessionId }, requestOptions),
    client.v2.session.question.list({ sessionID: sessionId }, requestOptions),
  ] as const);
  const permissions = pendingRequestsSchema.safeParse(permissionResponse.data);
  const questions = pendingRequestsSchema.safeParse(questionResponse.data);
  if (!permissions.success || !questions.success) {
    throw new OpenCodeExecutorError(
      "OpenCode returned invalid or oversized pending requests",
      !permissions.success ? permissions.error : questions.error,
    );
  }
  return {
    permissions: permissions.data,
    questions: questions.data,
  };
}

function waitForPoll(signal: AbortSignal, delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, delayMs);
    const onAbort = (): void => finish();
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) finish();
  });
}

function hasPendingRequests(
  pending: Awaited<ReturnType<typeof readPendingRequests>>,
): boolean {
  return (
    pending.permissions.data.length > 0 || pending.questions.data.length > 0
  );
}

async function readFinalHistory(
  client: OpencodeClient,
  sessionId: string,
  state: SessionMonitorState,
): Promise<unknown[]> {
  const signal = AbortSignal.timeout(finalPollTimeoutMs);
  try {
    return await drainSessionHistory(client, sessionId, state, signal, {
      collect: true,
      maxPages: maxHistoryPagesPerCycle,
    });
  } catch (cause) {
    if (!signal.aborted) throw cause;
    state.initialized = false;
    return [];
  }
}

/**
 * Do not replace this polling loop with `client.event.subscribe()`.
 *
 * OpenCode 1.18.27 retains a GlobalBus listener after an `/event` client
 * disconnects. Reopening that stream for sequential prompts eventually emits
 * `MaxListenersExceededWarning`. Keep monitoring on finite, session-scoped
 * endpoints until the server guarantees listener cleanup on disconnect.
 * See https://github.com/anomalyco/opencode/issues/29204.
 */
async function* pollSessionEvents(
  client: OpencodeClient,
  sessionId: string,
  state: SessionMonitorState,
  signal: AbortSignal,
): AsyncIterable<unknown> {
  let delayMs = initialPollDelayMs;
  while (!signal.aborted) {
    let events: unknown[];
    let pending: Awaited<ReturnType<typeof readPendingRequests>>;
    try {
      [events, pending] = await Promise.all([
        drainSessionHistory(client, sessionId, state, signal, {
          collect: true,
          maxPages: maxHistoryPagesPerCycle,
        }),
        readPendingRequests(client, sessionId, signal),
      ]);
    } catch (cause) {
      if (signal.aborted) break;
      throw cause;
    }
    for (const event of events) yield event;
    if (hasPendingRequests(pending)) {
      yield {
        type: "permission.v2.asked",
        data: { sessionID: sessionId },
      };
    }
    if (events.length > 0) delayMs = initialPollDelayMs;
    await waitForPoll(signal, delayMs);
    if (events.length === 0) {
      delayMs = Math.min(maxPollDelayMs, delayMs * 2);
    }
  }

  // Prompt completion can race the last durable events. Drain a bounded tail
  // with an independent timeout so cleanup cannot hang on the server.
  for (const event of await readFinalHistory(client, sessionId, state)) {
    yield event;
  }
}

function createSessionMonitor(
  client: OpencodeClient,
): OpenCodeTransport["monitorSession"] {
  const states = new Map<string, SessionMonitorState>();
  return async (sessionId, signal) => {
    const state = states.get(sessionId) ?? { initialized: false };
    states.set(sessionId, state);
    if (!state.initialized) {
      await drainSessionHistory(client, sessionId, state, signal, {
        collect: false,
        maxPages: maxHistoryBaselinePages,
      });
      state.initialized = true;
    }
    return pollSessionEvents(client, sessionId, state, signal);
  };
}

async function sdkResponseData<T>(
  response: Promise<{ readonly data: T }>,
): Promise<T> {
  return (await response).data;
}

/** Adapts the SDK's session API to the private session lifecycle. */
export function createOpenCodeTransport(
  url: string,
  authorization?: string,
): OpenCodeTransport {
  return createOpenCodeTransportFromClient(
    createOpenCodeClient(url, authorization),
  );
}

function createOpenCodeTransportFromClient(
  client: OpencodeClient,
): OpenCodeTransport {
  const monitorSession = createSessionMonitor(client);
  return {
    async createSession(workspace, signal) {
      const response = await client.session.create(
        {
          ...(workspace === undefined ? {} : { directory: workspace }),
        },
        { throwOnError: true, signal },
      );
      const session = sessionSchema.parse(response.data);
      return {
        sessionId: session.id,
        directory: session.directory,
        ...(workspace === undefined ? {} : { workspace: session.directory }),
      };
    },

    async prompt(sessionId, request, signal) {
      const response = await client.session.prompt(
        {
          sessionID: sessionId,
          parts: [{ type: "text", text: request.text }],
          ...(request.selection === undefined
            ? {}
            : {
                model: {
                  providerID: request.selection.model.provider,
                  modelID: request.selection.model.model,
                },
              }),
          ...(request.variant === undefined
            ? {}
            : { variant: request.variant }),
          ...(request.tools === undefined ? {} : { tools: request.tools }),
          ...(request.strategy === "prompt"
            ? {}
            : {
                format: {
                  type: "json_schema" as const,
                  schema: request.schema,
                  retryCount: request.retryCount ?? 2,
                },
              }),
        },
        { throwOnError: true, signal },
      );
      return response.data;
    },

    async getRuntimeVersion(signal) {
      try {
        const response = await client.global.health({
          throwOnError: true,
          signal,
        });
        const parsed = z
          .object({ healthy: z.literal(true), version: z.string() })
          .safeParse(response.data);
        return parsed.success ? parsed.data.version : undefined;
      } catch {
        return undefined;
      }
    },

    async listMessages(sessionId, signal) {
      return sdkResponseData(
        client.session.messages(
          { sessionID: sessionId },
          { throwOnError: true, signal },
        ),
      );
    },

    async forkSession(sessionId, messageId, signal) {
      const response = await client.session.fork(
        { sessionID: sessionId, messageID: messageId },
        { throwOnError: true, signal },
      );
      const session = sessionSchema.parse(response.data);
      return { sessionId: session.id, directory: session.directory };
    },

    async configureSession(sessionId, configuration, signal) {
      await client.session.init(
        {
          sessionID: sessionId,
          modelID: configuration.selection.model.model,
          providerID: configuration.selection.model.provider,
          messageID: configuration.messageId,
        },
        { throwOnError: true, signal },
      );
    },

    monitorSession,
    abort(sessionId, signal) {
      return client.session
        .abort({ sessionID: sessionId }, { throwOnError: true, signal })
        .then(() => undefined);
    },
  };
}
