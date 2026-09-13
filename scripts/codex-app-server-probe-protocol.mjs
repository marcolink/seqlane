import {
  MAX_LINE_BYTES,
  MAX_STRUCTURED_OUTPUT_BYTES,
} from "./codex-app-server-probe-constants.mjs";
export {
  readCodexVersion,
  versionDiagnostic,
} from "../libs/codex/src/version-shared.mjs";
const TURN_STATUSES = new Set([
  "completed",
  "interrupted",
  "failed",
  "inProgress",
]);

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJsonLine(line) {
  if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
    throw new Error("Codex app-server emitted an oversized JSONL line");
  }
  let value;
  try {
    value = JSON.parse(line);
  } catch (cause) {
    throw new Error("Codex app-server emitted invalid JSON", { cause });
  }
  if (!isRecord(value))
    throw new Error("Codex app-server message is not an object");
  validateProtocolEnvelope(value);
  return value;
}

function isRequestId(value) {
  return (
    (typeof value === "number" && Number.isInteger(value) && value >= 0) ||
    (typeof value === "string" && value.length > 0 && value.length <= 128)
  );
}

function validateProtocolEnvelope(message) {
  // Codex app-server JSONL omits this JSON-RPC field on current releases.
  if (message.jsonrpc !== undefined && message.jsonrpc !== "2.0")
    throw new Error("Codex app-server message has an invalid JSON-RPC marker");
  if (Object.hasOwn(message, "id") && !isRequestId(message.id))
    throw new Error("Codex app-server message has an invalid request id");
  if (typeof message.method === "string") {
    if (message.method.length === 0 || message.method.length > 256)
      throw new Error("Codex app-server message has an invalid method");
    if (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))
      throw new Error(
        "Codex app-server message mixes method and response fields",
      );
    return;
  }
  if (Object.hasOwn(message, "method"))
    throw new Error("Codex app-server message has an invalid method");
  if (!Object.hasOwn(message, "id"))
    throw new Error("Codex app-server message has neither method nor id");
  const hasResult = Object.hasOwn(message, "result");
  const hasError = Object.hasOwn(message, "error");
  if (hasResult === hasError)
    throw new Error("Codex app-server response must contain result or error");
  if (
    hasError &&
    (!isRecord(message.error) ||
      typeof message.error.code !== "number" ||
      !Number.isFinite(message.error.code) ||
      typeof message.error.message !== "string" ||
      message.error.message.length > 4_096)
  )
    throw new Error("Codex app-server response has an invalid error");
}

export function responseFor(message, id) {
  return (
    isRecord(message) &&
    message.id === id &&
    (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))
  );
}

export function notificationFor(message, method) {
  return (
    isRecord(message) &&
    message.method === method &&
    !Object.hasOwn(message, "id")
  );
}

export function serverRequestFor(message) {
  return (
    isRecord(message) &&
    typeof message.method === "string" &&
    Object.hasOwn(message, "id") &&
    !Object.hasOwn(message, "result") &&
    !Object.hasOwn(message, "error")
  );
}

export function approvalRequestFor(message, threadId, turnId) {
  return (
    serverRequestFor(message) &&
    message.method.includes("Approval") &&
    isRecord(message.params) &&
    message.params.threadId === threadId &&
    message.params.turnId === turnId
  );
}

export function responseResult(message, operation) {
  if (Object.hasOwn(message, "error")) {
    throw new Error(`${operation} failed: ${JSON.stringify(message.error)}`);
  }
  return message.result;
}

function nonEmptyString(value, description) {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${description} must be a non-empty string`);
  return value;
}

export function parseInitializeResult(result) {
  if (!isRecord(result)) throw new Error("initialize response was malformed");
  return {
    userAgent: nonEmptyString(result.userAgent, "initialize.userAgent"),
    codexHome: nonEmptyString(result.codexHome, "initialize.codexHome"),
    platformFamily: nonEmptyString(
      result.platformFamily,
      "initialize.platformFamily",
    ),
    platformOs: nonEmptyString(result.platformOs, "initialize.platformOs"),
  };
}

export function parseModelListResult(result) {
  if (!isRecord(result) || !Array.isArray(result.data))
    throw new Error("model/list response was malformed");
  return result.data.map((value, index) => {
    if (!isRecord(value))
      throw new Error(`model/list data[${index}] was malformed`);
    const efforts = value.supportedReasoningEfforts ?? [];
    if (!Array.isArray(efforts))
      throw new Error(`model/list data[${index}] efforts were malformed`);
    const supportedReasoningEfforts = efforts.map((effort, effortIndex) => {
      if (!isRecord(effort))
        throw new Error(
          `model/list data[${index}] effort[${effortIndex}] was malformed`,
        );
      return nonEmptyString(
        effort.reasoningEffort,
        `model/list data[${index}] reasoningEffort`,
      );
    });
    const isDefault = value.isDefault ?? false;
    if (typeof isDefault !== "boolean")
      throw new Error(`model/list data[${index}].isDefault was malformed`);
    return {
      id: nonEmptyString(value.id, `model/list data[${index}].id`),
      model: nonEmptyString(value.model, `model/list data[${index}].model`),
      isDefault,
      supportedReasoningEfforts,
    };
  });
}

export function defaultModel(models) {
  const model = models.find((value) => value.isDefault === true);
  if (model === undefined)
    throw new Error("model/list response did not contain a default model");
  return model.model;
}

export function parseTurnResult(result, operation) {
  if (!isRecord(result) || !isRecord(result.turn))
    throw new Error(`${operation} response did not contain a turn`);
  const turn = result.turn;
  const id = nonEmptyString(turn.id, `${operation}.turn.id`);
  if (typeof turn.status !== "string" || !TURN_STATUSES.has(turn.status))
    throw new Error(`${operation}.turn.status was malformed`);
  if (
    turn.items !== undefined &&
    (!Array.isArray(turn.items) || turn.items.some((item) => !isRecord(item)))
  )
    throw new Error(`${operation}.turn.items was malformed`);
  return { ...result, turn: { ...turn, id, items: turn.items ?? [] } };
}

export function parseThreadResult(result, operation = "thread") {
  if (!isRecord(result) || !isRecord(result.thread))
    throw new Error(`${operation} response did not contain a thread`);
  return {
    ...result,
    thread: {
      ...result.thread,
      id: nonEmptyString(result.thread.id, `${operation}.thread.id`),
    },
  };
}

export function completedTurn(message, threadId, turnId) {
  return (
    notificationFor(message, "turn/completed") &&
    isRecord(message.params) &&
    message.params.threadId === threadId &&
    isRecord(message.params.turn) &&
    message.params.turn.id === turnId
  );
}

export function completedTurnStatus(
  message,
  threadId,
  turnId,
  description,
  expectedStatus = "interrupted",
) {
  if (!completedTurn(message, threadId, turnId))
    throw new Error(`${description} did not contain a matching completed turn`);
  const parsed = parseTurnResult(message.params, description);
  if (parsed.turn.status !== expectedStatus)
    throw new Error(
      `${description} did not produce ${expectedStatus} status: ${JSON.stringify(parsed.turn)}`,
    );
  return parsed;
}

function agentMessageText(item) {
  if (!isRecord(item) || item.type !== "agentMessage") return undefined;
  if (typeof item.text === "string") return item.text;
  if (!Array.isArray(item.content)) return undefined;
  const text = item.content
    .filter(
      (part) =>
        isRecord(part) &&
        (part.type === "text" || part.type === "output_text") &&
        typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("");
  return text.length === 0 ? undefined : text;
}

export function findAgentMessage(messages, threadId, turnId) {
  const deltas = new Map();
  const candidates = [];
  for (const entry of messages) {
    if (entry.direction !== "server" || !isRecord(entry.message)) continue;
    const message = entry.message;
    if (!isRecord(message.params)) continue;
    if (
      message.params.threadId !== threadId ||
      (message.params.turnId !== undefined && message.params.turnId !== turnId)
    )
      continue;
    if (notificationFor(message, "item/agentMessage/delta")) {
      const itemId = nonEmptyString(
        message.params.itemId,
        "agent message itemId",
      );
      const delta = message.params.delta;
      if (typeof delta !== "string")
        throw new Error("agent message delta was malformed");
      deltas.set(itemId, `${deltas.get(itemId) ?? ""}${delta}`);
    } else if (notificationFor(message, "item/completed")) {
      const text = agentMessageText(message.params.item);
      if (text !== undefined) candidates.push(text);
    } else if (notificationFor(message, "turn/completed")) {
      const items = isRecord(message.params.turn)
        ? message.params.turn.items
        : undefined;
      for (const item of Array.isArray(items) ? items : []) {
        const text = agentMessageText(item);
        if (text !== undefined) candidates.push(text);
      }
    }
  }
  candidates.push(...deltas.values());
  const output = candidates.find((text) => text.length > 0);
  if (output === undefined)
    throw new Error("completed turn did not contain an agent message");
  if (Buffer.byteLength(output, "utf8") > MAX_STRUCTURED_OUTPUT_BYTES)
    throw new Error("agent message exceeded the structured output limit");
  return output;
}

export function assertProbeOutput(value) {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    value.version !== "probe" ||
    Object.keys(value).length !== 2
  ) {
    throw new Error(
      `structured output was not locally validatable: ${JSON.stringify(value)}`,
    );
  }
}

export function compactEvents(transcript, threadId, turnId) {
  return transcript
    .filter((entry) => entry.direction === "server")
    .map((entry) => entry.message)
    .filter(
      (message) =>
        isRecord(message) &&
        typeof message.method === "string" &&
        (!isRecord(message.params) ||
          message.params.threadId === threadId ||
          message.params.turnId === turnId),
    )
    .map((message) => message.method);
}

export function observedRequestShape(transcript, method) {
  const entry = transcript.find(
    (value) =>
      value.direction === "client" &&
      isRecord(value.message) &&
      value.message.method === method,
  );
  if (entry === undefined || !isRecord(entry.message.params))
    throw new Error(`client did not send ${method}`);
  const params = Object.fromEntries(
    Object.keys(entry.message.params)
      .sort()
      .map((key) => [
        key,
        key === "threadId"
          ? "<thread-id>"
          : key === "lastTurnId"
            ? "<completed-turn-id>"
            : key === "turnId"
              ? "<active-turn-id>"
              : "<redacted>",
      ]),
  );
  return { method, params };
}
