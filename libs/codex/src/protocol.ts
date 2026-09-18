import { z } from "zod";
import { CodexAdapterError, CodexProtocolError } from "./errors.js";
import { isAbsoluteCodexExecutablePath } from "./executable-path.js";

export const MAX_JSONL_LINE_BYTES = 4 * 1024 * 1024;
export const MAX_JSONL_BUFFER_BYTES = 8 * 1024 * 1024;
export const MAX_JSONL_OUTBOUND_MESSAGE_BYTES = MAX_JSONL_LINE_BYTES;
export const MAX_JSONL_OUTBOUND_PARAMS_BYTES = 2 * 1024 * 1024;

export type CodexRequestId = number | string;

const requestIdSchema = z.union([
  z.number().int().nonnegative(),
  z.string().min(1).max(128),
]);
const objectSchema = z.record(z.string(), z.unknown());

// Current Codex app-server JSONL omits the JSON-RPC marker on inbound messages.
const responseSchema = z
  .object({
    jsonrpc: z.literal("2.0").optional(),
    id: requestIdSchema,
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.number().finite(),
        message: z.string().max(4_096),
        data: z.unknown().optional(),
      })
      .optional(),
  })
  .passthrough();

const notificationSchema = z
  .object({
    jsonrpc: z.literal("2.0").optional(),
    method: z.string().min(1).max(256),
    params: z.unknown().optional(),
  })
  .passthrough();

const serverRequestSchema = z
  .object({
    jsonrpc: z.literal("2.0").optional(),
    id: requestIdSchema,
    method: z.string().min(1).max(256),
    params: z.unknown().optional(),
  })
  .passthrough();

const turnSchema = z
  .object({
    id: z.string().min(1).max(256),
    status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
    items: z.array(objectSchema).optional(),
    error: z
      .object({ message: z.string().max(4_096) })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

const threadSchema = z.object({ id: z.string().min(1).max(256) }).passthrough();

const initializeResultSchema = z
  .object({
    userAgent: z.string().min(1),
    codexHome: z.string().min(1),
    platformFamily: z.string().min(1),
    platformOs: z.string().min(1),
  })
  .passthrough();

export const codexLaunchConfigurationSchema = z
  .object({
    executable: z.string().min(1),
    workspace: z.string().min(1),
    networkAccess: z.boolean().default(false),
  })
  .strict();

export type CodexLaunchConfiguration = z.output<
  typeof codexLaunchConfigurationSchema
>;

export function parseCodexLaunchConfiguration(
  value: unknown,
  platform: NodeJS.Platform = process.platform,
): CodexLaunchConfiguration {
  const parsed = codexLaunchConfigurationSchema.parse(value);
  if (!isAbsoluteCodexExecutablePath(parsed.executable, platform)) {
    throw new CodexAdapterError(
      "configuration",
      "Codex executable must be an absolute path",
    );
  }
  return parsed;
}

export interface CodexThread {
  readonly id: string;
}

export interface CodexInitializeResult {
  readonly userAgent: string;
  readonly codexHome: string;
  readonly platformFamily: string;
  readonly platformOs: string;
}

export interface CodexTurn {
  readonly id: string;
  readonly status: "completed" | "interrupted" | "failed" | "inProgress";
  readonly items: readonly Record<string, unknown>[];
  readonly error?: { readonly message: string };
}

export interface CodexTokenUsage {
  readonly total: {
    readonly totalTokens: number;
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    readonly cacheWriteInputTokens: number;
    readonly outputTokens: number;
    readonly reasoningOutputTokens: number;
  };
  readonly last: {
    readonly totalTokens: number;
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    readonly cacheWriteInputTokens: number;
    readonly outputTokens: number;
    readonly reasoningOutputTokens: number;
  };
}

export type CodexNotification =
  | {
      readonly method: "turn/started";
      readonly params: { readonly threadId: string; readonly turn: CodexTurn };
    }
  | {
      readonly method: "turn/completed";
      readonly params: { readonly threadId: string; readonly turn: CodexTurn };
    }
  | {
      readonly method: "item/started";
      readonly params: {
        readonly threadId: string;
        readonly turnId: string;
        readonly item: Record<string, unknown>;
        readonly startedAtMs?: number;
      };
    }
  | {
      readonly method: "item/completed";
      readonly params: {
        readonly threadId: string;
        readonly turnId: string;
        readonly item: Record<string, unknown>;
        readonly completedAtMs?: number;
      };
    }
  | {
      readonly method: "item/agentMessage/delta";
      readonly params: {
        readonly threadId: string;
        readonly turnId: string;
        readonly itemId: string;
        readonly delta: string;
      };
    }
  | {
      readonly method: "thread/tokenUsage/updated";
      readonly params: {
        readonly threadId: string;
        readonly turnId: string;
        readonly tokenUsage: CodexTokenUsage;
      };
    }
  | { readonly method: string; readonly params: unknown };

export interface CodexServerRequest {
  readonly id: CodexRequestId;
  readonly method: string;
  readonly params: unknown;
}

export interface CodexRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export type CodexServerRequestResponse =
  | { readonly result: unknown; readonly error?: never }
  | { readonly error: CodexRpcError; readonly result?: never };

export function unsupportedCodexServerRequest(
  request: CodexServerRequest,
): CodexServerRequestResponse {
  return {
    error: {
      code: -32601,
      message: `Unsupported Codex server request "${request.method}"`,
    },
  };
}

export type CodexInboundMessage =
  | {
      readonly kind: "response";
      readonly id: CodexRequestId;
      readonly result?: unknown;
      readonly error?: {
        readonly code: number;
        readonly message: string;
        readonly data?: unknown;
      };
    }
  | { readonly kind: "notification"; readonly notification: CodexNotification }
  | { readonly kind: "server-request"; readonly request: CodexServerRequest };

function parseTurn(value: unknown): CodexTurn {
  const parsed = turnSchema.safeParse(value);
  if (!parsed.success) throw new CodexProtocolError("invalid turn payload");
  return {
    id: parsed.data.id,
    status: parsed.data.status,
    items: parsed.data.items ?? [],
    ...(parsed.data.error === undefined || parsed.data.error === null
      ? {}
      : { error: { message: parsed.data.error.message } }),
  };
}

function parseKnownNotification(
  method: string,
  params: unknown,
): CodexNotification {
  if (method === "turn/started" || method === "turn/completed") {
    const parsed = z
      .object({ threadId: z.string().min(1), turn: z.unknown() })
      .safeParse(params);
    if (!parsed.success)
      throw new CodexProtocolError(`invalid ${method} payload`);
    return {
      method,
      params: {
        threadId: parsed.data.threadId,
        turn: parseTurn(parsed.data.turn),
      },
    } as CodexNotification;
  }
  if (method === "item/started" || method === "item/completed") {
    const parsed = z
      .object({
        threadId: z.string().min(1),
        turnId: z.string().min(1),
        item: objectSchema,
        startedAtMs: z.number().finite().optional(),
        completedAtMs: z.number().finite().optional(),
      })
      .safeParse(params);
    if (!parsed.success)
      throw new CodexProtocolError(`invalid ${method} payload`);
    const timestamp =
      method === "item/started"
        ? parsed.data.startedAtMs
        : parsed.data.completedAtMs;
    return {
      method,
      params: {
        threadId: parsed.data.threadId,
        turnId: parsed.data.turnId,
        item: parsed.data.item,
        ...(timestamp === undefined
          ? {}
          : {
              [method === "item/started" ? "startedAtMs" : "completedAtMs"]:
                timestamp,
            }),
      },
    } as CodexNotification;
  }
  if (method === "item/agentMessage/delta") {
    const parsed = z
      .object({
        threadId: z.string().min(1),
        turnId: z.string().min(1),
        itemId: z.string().min(1),
        delta: z.string(),
      })
      .safeParse(params);
    if (!parsed.success)
      throw new CodexProtocolError("invalid agent message delta payload");
    return { method, params: parsed.data };
  }
  if (method === "thread/tokenUsage/updated") {
    const usage = z
      .object({
        total: z.object({
          totalTokens: z.number().finite().nonnegative(),
          inputTokens: z.number().finite().nonnegative(),
          cachedInputTokens: z.number().finite().nonnegative(),
          cacheWriteInputTokens: z.number().finite().nonnegative(),
          outputTokens: z.number().finite().nonnegative(),
          reasoningOutputTokens: z.number().finite().nonnegative(),
        }),
        last: z.object({
          totalTokens: z.number().finite().nonnegative(),
          inputTokens: z.number().finite().nonnegative(),
          cachedInputTokens: z.number().finite().nonnegative(),
          cacheWriteInputTokens: z.number().finite().nonnegative(),
          outputTokens: z.number().finite().nonnegative(),
          reasoningOutputTokens: z.number().finite().nonnegative(),
        }),
      })
      .safeParse((params as Record<string, unknown> | undefined)?.tokenUsage);
    const envelope = z
      .object({ threadId: z.string().min(1), turnId: z.string().min(1) })
      .safeParse(params);
    if (!usage.success || !envelope.success)
      throw new CodexProtocolError("invalid token usage payload");
    return { method, params: { ...envelope.data, tokenUsage: usage.data } };
  }
  return { method, params };
}

export function parseCodexMessage(value: unknown): CodexInboundMessage {
  const object = objectSchema.safeParse(value);
  if (!object.success)
    throw new CodexProtocolError("JSONL message must be an object");
  const record = object.data;
  if (record.id !== undefined && record.method !== undefined) {
    const parsed = serverRequestSchema.safeParse(record);
    if (!parsed.success)
      throw new CodexProtocolError("invalid server request envelope");
    return {
      kind: "server-request",
      request: {
        id: parsed.data.id,
        method: parsed.data.method,
        params: parsed.data.params,
      },
    };
  }
  if (record.id !== undefined) {
    const parsed = responseSchema.safeParse(record);
    if (
      !parsed.success ||
      (parsed.data.result === undefined && parsed.data.error === undefined)
    ) {
      throw new CodexProtocolError("invalid response envelope");
    }
    return {
      kind: "response",
      id: parsed.data.id,
      ...(parsed.data.result === undefined
        ? {}
        : { result: parsed.data.result }),
      ...(parsed.data.error === undefined ? {} : { error: parsed.data.error }),
    };
  }
  const parsed = notificationSchema.safeParse(record);
  if (!parsed.success)
    throw new CodexProtocolError("invalid notification envelope");
  return {
    kind: "notification",
    notification: parseKnownNotification(
      parsed.data.method,
      parsed.data.params,
    ),
  };
}

export function parseThreadResult(value: unknown): CodexThread {
  const parsed = z.object({ thread: threadSchema }).safeParse(value);
  if (!parsed.success)
    throw new CodexProtocolError("thread response did not contain a thread");
  return { id: parsed.data.thread.id };
}

export function parseTurnStartResult(value: unknown): CodexTurn {
  const parsed = z.object({ turn: z.unknown() }).safeParse(value);
  if (!parsed.success)
    throw new CodexProtocolError("turn response did not contain a turn");
  return parseTurn(parsed.data.turn);
}

export function parseModelListResult(value: unknown): readonly {
  readonly id: string;
  readonly model: string;
  readonly supportedReasoningEfforts: readonly string[];
  readonly isDefault: boolean;
}[] {
  const parsed = z
    .object({
      data: z.array(
        z.object({
          id: z.string().min(1),
          model: z.string().min(1),
          supportedReasoningEfforts: z
            .array(z.object({ reasoningEffort: z.string().min(1) }))
            .default([]),
          isDefault: z.boolean().default(false),
        }),
      ),
      nextCursor: z.string().nullable().optional(),
    })
    .safeParse(value);
  if (!parsed.success)
    throw new CodexProtocolError("model/list response was malformed");
  return parsed.data.data.map((model) => ({
    id: model.id,
    model: model.model,
    supportedReasoningEfforts: model.supportedReasoningEfforts.map(
      (effort) => effort.reasoningEffort,
    ),
    isDefault: model.isDefault,
  }));
}

export function parseInitializeResult(value: unknown): CodexInitializeResult {
  const parsed = initializeResultSchema.safeParse(value);
  if (!parsed.success)
    throw new CodexProtocolError("initialize response was malformed");
  return {
    userAgent: parsed.data.userAgent,
    codexHome: parsed.data.codexHome,
    platformFamily: parsed.data.platformFamily,
    platformOs: parsed.data.platformOs,
  };
}
