import { z } from "zod";

const boundedId = z.string().min(1).max(256);
const nonNegativeFinite = z.number().finite().nonnegative();

const tokenSchema = z.object({
  input: nonNegativeFinite,
  output: nonNegativeFinite,
  reasoning: nonNegativeFinite,
  cache: z.object({
    read: nonNegativeFinite,
    write: nonNegativeFinite,
  }),
});

const assistantSchema = z.object({
  id: boundedId,
  sessionID: boundedId,
  role: z.literal("assistant"),
  time: z.object({
    created: nonNegativeFinite,
    completed: nonNegativeFinite.optional(),
  }),
  modelID: boundedId,
  providerID: boundedId,
  cost: nonNegativeFinite,
  tokens: tokenSchema,
  finish: z.string().max(256).optional(),
  error: z
    .object({ name: z.string().max(256) })
    .passthrough()
    .optional(),
});

const toolPartSchema = z.object({
  id: boundedId,
  sessionID: boundedId,
  messageID: boundedId,
  type: z.literal("tool"),
  callID: boundedId,
  tool: boundedId,
  state: z.discriminatedUnion("status", [
    z.object({
      status: z.enum(["pending", "running"]),
      input: z.record(z.string(), z.unknown()).optional(),
      output: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
      time: z
        .object({ start: nonNegativeFinite, end: nonNegativeFinite.optional() })
        .optional(),
    }),
    z.object({
      status: z.literal("completed"),
      input: z.record(z.string(), z.unknown()).optional(),
      output: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
      time: z.object({ start: nonNegativeFinite, end: nonNegativeFinite }),
    }),
    z.object({
      status: z.literal("error"),
      input: z.record(z.string(), z.unknown()).optional(),
      output: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
      time: z.object({ start: nonNegativeFinite, end: nonNegativeFinite }),
    }),
  ]),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const legacyToolPartSchema = z.looseObject({
  type: z.literal("tool"),
  callID: boundedId,
  tool: boundedId,
  messageID: boundedId.optional(),
  state: z.looseObject({
    status: z.enum(["pending", "running", "completed", "error"]),
    input: z.record(z.string(), z.unknown()).optional(),
    output: z.unknown().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    time: z
      .looseObject({
        start: nonNegativeFinite.optional(),
        end: nonNegativeFinite.optional(),
      })
      .optional(),
  }),
});

const legacyNextToolSchema = z.looseObject({
  sessionID: boundedId,
  assistantMessageID: boundedId.optional(),
  callID: boundedId,
  tool: boundedId.optional(),
  name: boundedId.optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  timestamp: nonNegativeFinite.optional(),
  result: z.unknown().optional(),
  structured: z.unknown().optional(),
  content: z.unknown().optional(),
});

const shellStartedSchema = z.looseObject({
  sessionID: boundedId,
  command: z.string().min(1).max(4096),
});

const eventSchema = z.object({
  type: z.string(),
  properties: z.record(z.string(), z.unknown()).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

export interface OpenCodeAssistantObservation {
  readonly kind: "assistant";
  readonly sessionID: string;
  readonly messageID: string;
  readonly created: number;
  readonly completed?: number;
  readonly provider: string;
  readonly model: string;
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly reasoning: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
  };
  readonly cost: number;
  readonly finish?: string;
  readonly error?: string;
}

export interface OpenCodeToolObservation {
  readonly kind: "tool";
  readonly sessionID: string;
  readonly messageID: string;
  readonly callID: string;
  readonly tool: string;
  readonly status: "pending" | "running" | "completed" | "error";
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly input?: Record<string, unknown>;
  readonly output?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface OpenCodeLegacyToolObservation {
  readonly sessionID: string;
  readonly messageID?: string;
  readonly callID: string;
  readonly tool?: string;
  readonly status:
    | "pending"
    | "running"
    | "completed"
    | "error"
    | "called"
    | "progress"
    | "success"
    | "failed";
  readonly input?: Record<string, unknown>;
  readonly output?: unknown;
  readonly metadata?: Record<string, unknown>;
  readonly startedAt?: number;
  readonly endedAt?: number;
}

export type OpenCodeEventObservation =
  OpenCodeAssistantObservation | OpenCodeToolObservation;

export interface ParsedOpenCodeEvent {
  readonly type: string;
  readonly details: Record<string, unknown>;
  readonly sessionMatches: boolean;
  readonly validity: "valid" | "unsupported" | "malformed";
  readonly interaction: boolean;
  readonly backgroundProcess: boolean;
  readonly observation?: OpenCodeEventObservation;
  readonly legacyTool?: OpenCodeLegacyToolObservation;
}

export interface OpenCodeTerminalObservation extends OpenCodeAssistantObservation {
  readonly kind: "assistant";
}

function stringField(
  details: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = details[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nestedSessionID(
  type: string,
  details: Record<string, unknown>,
): string | undefined {
  const nested =
    type === "message.updated"
      ? details.info
      : type === "message.part.updated"
        ? details.part
        : undefined;
  const parsed = z.record(z.string(), z.unknown()).safeParse(nested);
  const nestedSession = parsed.success
    ? stringField(parsed.data, "sessionID")
    : undefined;
  return nestedSession ?? stringField(details, "sessionID");
}

function nestedStringField(value: unknown, key: string): string | undefined {
  const parsed = z.record(z.string(), z.unknown()).safeParse(value);
  return parsed.success ? stringField(parsed.data, key) : undefined;
}

function assistantObservation(
  info: z.infer<typeof assistantSchema>,
): OpenCodeAssistantObservation {
  return {
    kind: "assistant",
    sessionID: info.sessionID,
    messageID: info.id,
    created: info.time.created,
    ...(info.time.completed === undefined
      ? {}
      : { completed: info.time.completed }),
    provider: info.providerID,
    model: info.modelID,
    tokens: {
      input: info.tokens.input,
      output: info.tokens.output,
      reasoning: info.tokens.reasoning,
      cacheRead: info.tokens.cache.read,
      cacheWrite: info.tokens.cache.write,
    },
    cost: info.cost,
    ...(info.finish === undefined ? {} : { finish: info.finish }),
    ...(info.error === undefined ? {} : { error: info.error.name }),
  };
}

function toolObservation(
  part: z.infer<typeof toolPartSchema>,
): OpenCodeToolObservation {
  return {
    kind: "tool",
    sessionID: part.sessionID,
    messageID: part.messageID,
    callID: part.callID,
    tool: part.tool,
    status: part.state.status,
    ...(part.state.time?.start === undefined
      ? {}
      : { startedAt: part.state.time.start }),
    ...(part.state.time?.end === undefined
      ? {}
      : { endedAt: part.state.time.end }),
    ...(part.state.input === undefined ? {} : { input: part.state.input }),
    ...(part.state.output === undefined ? {} : { output: part.state.output }),
    ...(part.state.metadata === undefined && part.metadata === undefined
      ? {}
      : { metadata: part.state.metadata ?? part.metadata }),
  };
}

function legacyToolObservation(
  details: Record<string, unknown>,
  type: string,
): OpenCodeLegacyToolObservation | undefined {
  if (type === "message.part.updated") {
    const part = z.record(z.string(), z.unknown()).safeParse(details.part);
    if (!part.success) return undefined;
    const parsed = legacyToolPartSchema.safeParse(part.data);
    if (!parsed.success) return undefined;
    const state = parsed.data.state;
    const sessionID = stringField(details, "sessionID");
    if (sessionID === undefined) return undefined;
    return {
      sessionID,
      ...(parsed.data.messageID === undefined
        ? {}
        : { messageID: parsed.data.messageID }),
      callID: parsed.data.callID,
      tool: parsed.data.tool,
      status: state.status,
      ...(state.input === undefined ? {} : { input: state.input }),
      ...(state.output === undefined ? {} : { output: state.output }),
      ...(state.metadata === undefined ? {} : { metadata: state.metadata }),
      ...(state.time?.start === undefined
        ? {}
        : { startedAt: state.time.start }),
      ...(state.time?.end === undefined ? {} : { endedAt: state.time.end }),
    };
  }

  if (
    type !== "session.next.tool.called" &&
    type !== "session.next.tool.input.started" &&
    type !== "session.next.tool.input.ended" &&
    type !== "session.next.tool.progress" &&
    type !== "session.next.tool.success" &&
    type !== "session.next.tool.failed"
  ) {
    return undefined;
  }
  const parsed = legacyNextToolSchema.safeParse(details);
  if (!parsed.success) return undefined;
  const status =
    type === "session.next.tool.success"
      ? "success"
      : type === "session.next.tool.failed"
        ? "failed"
        : type === "session.next.tool.progress"
          ? "progress"
          : "called";
  const output =
    parsed.data.result ?? parsed.data.structured ?? parsed.data.content;
  return {
    sessionID: parsed.data.sessionID,
    ...(parsed.data.assistantMessageID === undefined
      ? {}
      : { messageID: parsed.data.assistantMessageID }),
    callID: parsed.data.callID,
    ...(parsed.data.tool === undefined && parsed.data.name === undefined
      ? {}
      : { tool: parsed.data.tool ?? parsed.data.name }),
    status,
    ...(parsed.data.input === undefined ? {} : { input: parsed.data.input }),
    ...(output === undefined ? {} : { output }),
    ...(parsed.data.metadata === undefined
      ? {}
      : { metadata: parsed.data.metadata }),
    ...(parsed.data.timestamp === undefined
      ? {}
      : { startedAt: parsed.data.timestamp }),
  };
}

function isMutatingBackgroundProcess(
  details: Record<string, unknown>,
): boolean {
  const parsed = shellStartedSchema.safeParse(details);
  if (!parsed.success) return false;
  return (
    /&\s*(?:#.*)?$/.test(parsed.data.command) ||
    /(?:^|[;&|]\s*)(?:nohup|setsid)\b/.test(parsed.data.command)
  );
}

/** Validates an SDK event once and returns the reducer input plus its envelope. */
export function parseOpenCodeEvent(
  value: unknown,
  sessionID: string,
): ParsedOpenCodeEvent | undefined {
  const event = eventSchema.safeParse(value);
  if (!event.success) return undefined;
  const details = event.data.properties ?? event.data.data;
  if (details === undefined) return undefined;
  const sessionMatches =
    nestedSessionID(event.data.type, details) === sessionID;
  const interaction =
    [
      "permission.asked",
      "permission.v2.asked",
      "question.asked",
      "question.v2.asked",
    ].includes(event.data.type) && sessionMatches;

  if (event.data.type === "message.updated") {
    const info = assistantSchema.safeParse(details.info);
    if (!info.success) {
      return {
        type: event.data.type,
        details,
        sessionMatches,
        interaction,
        backgroundProcess: false,
        validity:
          nestedStringField(details.info, "role") === "user"
            ? "unsupported"
            : "malformed",
      };
    }
    return {
      type: event.data.type,
      details,
      sessionMatches,
      interaction,
      backgroundProcess: false,
      validity: "valid",
      ...(sessionMatches
        ? { observation: assistantObservation(info.data) }
        : {}),
    };
  }

  if (event.data.type === "message.part.updated") {
    const part = toolPartSchema.safeParse(details.part);
    if (!part.success) {
      const legacyTool = sessionMatches
        ? legacyToolObservation(details, event.data.type)
        : undefined;
      if (legacyTool !== undefined) {
        return {
          type: event.data.type,
          details,
          sessionMatches,
          interaction,
          backgroundProcess: false,
          validity: "valid",
          legacyTool,
        };
      }
      return {
        type: event.data.type,
        details,
        sessionMatches,
        interaction,
        backgroundProcess: false,
        validity:
          nestedStringField(details.part, "type") !== "tool"
            ? "unsupported"
            : "malformed",
      };
    }
    return {
      type: event.data.type,
      details,
      sessionMatches,
      interaction,
      backgroundProcess: false,
      validity: "valid",
      ...(sessionMatches ? { observation: toolObservation(part.data) } : {}),
    };
  }

  const legacyTool = sessionMatches
    ? legacyToolObservation(details, event.data.type)
    : undefined;
  return {
    type: event.data.type,
    details,
    sessionMatches,
    validity: "valid",
    interaction,
    backgroundProcess:
      sessionMatches &&
      event.data.type === "session.next.shell.started" &&
      isMutatingBackgroundProcess(details),
    ...(legacyTool === undefined ? {} : { legacyTool }),
  };
}

export function parseOpenCodeObservation(
  value: unknown,
  sessionID: string,
): OpenCodeEventObservation | undefined {
  return parseOpenCodeEvent(value, sessionID)?.observation;
}

export function terminalObservationFromParsedResponse(
  info: unknown,
): OpenCodeTerminalObservation | undefined {
  const parsed = assistantSchema.safeParse(info);
  if (!parsed.success) return undefined;
  return assistantObservation(parsed.data);
}
