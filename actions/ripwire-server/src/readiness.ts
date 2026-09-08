import { createConnection, type Socket } from "node:net";
import { z } from "zod";

export interface ParsedListenAddress {
  readonly host: string;
  readonly port: number;
  readonly listen: string;
  readonly mcpUrl: string;
}

export const MCP_INITIALIZE_REQUEST = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "seqlane-ripwire-action", version: "1.0.0" },
  },
} as const;

export const RIPWIRE_SERVER_INFO_VERSION = "1.0";
export const MAX_STARTUP_TIMEOUT_MILLISECONDS = 600_000;

export type ReadinessOwnershipCheck = (
  remainingMilliseconds: number,
) => Promise<void>;
export type ReadinessSocketConnector = (
  host: string,
  port: number,
  timeoutMilliseconds: number,
) => Promise<Socket>;

function assertReadinessTimeout(timeoutMilliseconds: number): void {
  if (
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds <= 0 ||
    timeoutMilliseconds > MAX_STARTUP_TIMEOUT_MILLISECONDS
  ) {
    throw new Error(
      `Ripwire readiness timeout must be a safe integer from 1 to ${MAX_STARTUP_TIMEOUT_MILLISECONDS} milliseconds`,
    );
  }
}

function initializeResponseSchema() {
  return z
    .object({
      jsonrpc: z.literal("2.0"),
      id: z.literal(1),
      result: z
        .object({
          protocolVersion: z.literal(
            MCP_INITIALIZE_REQUEST.params.protocolVersion,
          ),
          capabilities: z.record(z.string(), z.unknown()),
          serverInfo: z
            .object({
              name: z.literal("ripwire"),
              version: z.literal(RIPWIRE_SERVER_INFO_VERSION),
            })
            .passthrough(),
        })
        .passthrough(),
    })
    .passthrough();
}

function parsePort(value: string): number {
  if (!/^\d{1,5}$/.test(value))
    throw new Error("listen must include a port from 1 to 65535");
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("listen must include a port from 1 to 65535");
  }
  return port;
}

function parseIPv4(host: string): string | undefined {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) return undefined;
  const octets = host.split(".").map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) {
    throw new Error("listen must use localhost or an IPv4 address");
  }
  return octets.join(".");
}

export function parseListenAddress(listen: string): ParsedListenAddress {
  if (listen.trim() !== listen || listen.length === 0) {
    throw new Error(
      "listen must use localhost or an IPv4 address with an explicit port",
    );
  }
  const separator = listen.lastIndexOf(":");
  if (
    separator <= 0 ||
    separator === listen.length - 1 ||
    listen.indexOf(":") !== separator
  ) {
    throw new Error(
      "listen must use localhost or an IPv4 address with an explicit port",
    );
  }
  const rawHost = listen.slice(0, separator).toLowerCase();
  const host = rawHost === "localhost" ? rawHost : parseIPv4(rawHost);
  if (!host) throw new Error("listen must use localhost or an IPv4 address");
  const port = parsePort(listen.slice(separator + 1));
  const canonicalListen = `${host}:${port}`;
  return {
    host,
    port,
    listen: canonicalListen,
    mcpUrl: `http://${canonicalListen}/mcp`,
  };
}

export function parseMcpResponseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Continue with the one-event Streamable HTTP SSE representation.
  }
  const events = text
    .split(/\r?\n\r?\n/)
    .map((event) =>
      event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim()),
    )
    .filter((dataLines) => dataLines.length > 0);
  if (events.length !== 1) {
    throw new Error("Ripwire MCP readiness returned more than one SSE event");
  }
  return JSON.parse(events[0]?.join("\n") ?? "");
}

async function readBody(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error("Ripwire readiness response exceeded its size limit");
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes)
        throw new Error("Ripwire readiness response exceeded its size limit");
      chunks.push(next.value);
    }
  } finally {
    await Promise.resolve(reader.cancel()).catch(() => undefined);
  }
  return new TextDecoder().decode(
    chunks.reduce((all, chunk) => {
      const merged = new Uint8Array(all.length + chunk.length);
      merged.set(all);
      merged.set(chunk, all.length);
      return merged;
    }, new Uint8Array()),
  );
}

interface RawMcpResponse {
  readonly status: number;
  readonly body: string;
}

interface FetchMcpResponse extends RawMcpResponse {
  readonly response: Response;
}

function isFetchMcpResponse(
  response: RawMcpResponse | FetchMcpResponse,
): response is FetchMcpResponse {
  return "response" in response;
}

function connectReadinessSocket(
  host: string,
  port: number,
  timeoutMilliseconds: number,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(timeoutMilliseconds);
    let connected = false;
    const finish = (error?: Error) => {
      socket.off("connect", onConnect);
      socket.off("error", onError);
      if (error) socket.off("timeout", onTimeout);
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        resolve(socket);
      }
    };
    const onConnect = () => {
      connected = true;
      socket.setTimeout(timeoutMilliseconds);
      finish();
    };
    const onError = (error: Error) => finish(error);
    const onTimeout = () => {
      const error = new Error("Ripwire MCP readiness socket timed out");
      if (!connected) finish(error);
      else socket.destroy(error);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
  });
}

function findHeaderEnd(buffer: Buffer): number {
  return buffer.indexOf("\r\n\r\n");
}

function parseRawMcpResponse(buffer: Buffer): RawMcpResponse {
  const headerEnd = findHeaderEnd(buffer);
  if (headerEnd < 0) throw new Error("MCP readiness response has no headers");
  const headerText = buffer.subarray(0, headerEnd).toString("latin1");
  const lines = headerText.split("\r\n");
  const status = Number(lines[0]?.match(/^HTTP\/\d\.\d\s+(\d+)/)?.[1]);
  if (!Number.isInteger(status)) {
    throw new Error("MCP readiness response has an invalid status");
  }
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(":");
    if (separator > 0) {
      headers.set(
        line.slice(0, separator).toLowerCase(),
        line.slice(separator + 1).trim(),
      );
    }
  }
  const body = buffer.subarray(headerEnd + 4);
  const contentLength = headers.get("content-length");
  if (contentLength !== undefined) {
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length < 0 || body.length < length) {
      throw new Error("MCP readiness response has an invalid body length");
    }
    return { status, body: body.subarray(0, length).toString("utf8") };
  }
  if (headers.get("transfer-encoding")?.toLowerCase() === "chunked") {
    return { status, body: decodeChunkedBody(body) };
  }
  return { status, body: body.toString("utf8") };
}

function decodeChunkedBody(body: Buffer): string {
  let offset = 0;
  const chunks: Buffer[] = [];
  while (offset < body.length) {
    const lineEnd = body.indexOf("\r\n", offset);
    if (lineEnd < 0)
      throw new Error("MCP readiness response has invalid chunks");
    const size = Number.parseInt(
      body.subarray(offset, lineEnd).toString("ascii").split(";", 1)[0] ?? "",
      16,
    );
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error("MCP readiness response has invalid chunks");
    }
    offset = lineEnd + 2;
    if (size === 0) return Buffer.concat(chunks).toString("utf8");
    if (offset + size + 2 > body.length) {
      throw new Error("MCP readiness response has incomplete chunks");
    }
    chunks.push(body.subarray(offset, offset + size));
    offset += size;
    if (body.subarray(offset, offset + 2).toString() !== "\r\n") {
      throw new Error("MCP readiness response has invalid chunks");
    }
    offset += 2;
  }
  throw new Error("MCP readiness response has incomplete chunks");
}

async function requestOnVerifiedSocket(
  url: string,
  token: string | undefined,
  timeoutMilliseconds: number,
  assertOwnership: ReadinessOwnershipCheck,
  connectSocket: ReadinessSocketConnector,
): Promise<RawMcpResponse> {
  const endpoint = new URL(url);
  const deadline = Date.now() + timeoutMilliseconds;
  const remainingMilliseconds = (): number => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error("Ripwire MCP readiness socket timed out");
    }
    return remaining;
  };
  const port = Number(endpoint.port);
  const socket = await connectSocket(
    endpoint.hostname,
    port,
    remainingMilliseconds(),
  );
  try {
    let ownershipErrorHandler: ((error: Error) => void) | undefined;
    const socketError = new Promise<never>((_resolve, reject) => {
      ownershipErrorHandler = reject;
      socket.once("error", ownershipErrorHandler);
    });
    try {
      await Promise.race([
        assertOwnership(remainingMilliseconds()),
        socketError,
      ]);
    } finally {
      if (ownershipErrorHandler) {
        socket.off("error", ownershipErrorHandler);
      }
    }
    const responseTimeoutMilliseconds = remainingMilliseconds();
    socket.setTimeout(responseTimeoutMilliseconds);
    const body = JSON.stringify(MCP_INITIALIZE_REQUEST);
    const headers = [
      `POST ${endpoint.pathname} HTTP/1.1`,
      `Host: ${endpoint.host}`,
      "Accept: application/json, text/event-stream",
      "Content-Type: application/json",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "Connection: close",
    ];
    if (token) headers.push(`Authorization: Bearer ${token}`);
    const request = `${headers.join("\r\n")}\r\n\r\n${body}`;
    const response = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const onData = (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > 1_024 * 1_024) {
          socket.destroy();
          reject(
            new Error("Ripwire readiness response exceeded its size limit"),
          );
          return;
        }
        chunks.push(chunk);
      };
      const onError = (error: Error) => settle(reject, error);
      const onTimeout = () =>
        settle(reject, new Error("Ripwire MCP readiness socket timed out"));
      const onEnd = () => settle(resolve, Buffer.concat(chunks));
      const cleanup = () => {
        socket.off("error", onError);
        socket.off("timeout", onTimeout);
        socket.off("end", onEnd);
        socket.off("data", onData);
      };
      const settle = <T>(finish: (value: T) => void, value: T) => {
        cleanup();
        finish(value);
      };
      socket.once("error", onError);
      socket.once("timeout", onTimeout);
      socket.once("end", onEnd);
      socket.on("data", onData);
      socket.write(request);
    });
    return parseRawMcpResponse(response);
  } finally {
    socket.destroy();
  }
}

export async function checkMcpInitialize(
  url: string,
  token: string | undefined,
  timeoutMilliseconds: number,
  fetchImpl: typeof fetch = fetch,
  assertOwnership?: ReadinessOwnershipCheck,
  connectSocket: ReadinessSocketConnector = connectReadinessSocket,
): Promise<void> {
  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  assertReadinessTimeout(timeoutMilliseconds);
  const response: RawMcpResponse | FetchMcpResponse = assertOwnership
    ? await requestOnVerifiedSocket(
        url,
        token,
        timeoutMilliseconds,
        assertOwnership,
        connectSocket,
      )
    : await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(MCP_INITIALIZE_REQUEST),
        signal: AbortSignal.timeout(
          Math.max(1, Math.floor(timeoutMilliseconds)),
        ),
      }).then(async (result) => ({
        status: result.status,
        body: await readBody(result, 1_024 * 1_024),
        response: result,
      }));
  try {
    if (response.status !== 200) {
      throw new Error(`Ripwire MCP readiness returned HTTP ${response.status}`);
    }
    let parsed: unknown;
    try {
      parsed = parseMcpResponseBody(response.body);
    } catch (error) {
      throw new Error("Ripwire MCP readiness returned invalid JSON", {
        cause: error,
      });
    }
    const result = initializeResponseSchema().safeParse(parsed);
    if (!result.success) {
      throw new Error(
        "Ripwire MCP readiness returned an invalid initialize response",
        {
          cause: result.error,
        },
      );
    }
  } finally {
    if (isFetchMcpResponse(response)) {
      await Promise.resolve(response.response.body?.cancel()).catch(
        () => undefined,
      );
    }
  }
}

export async function waitForMcpHealth(
  check: (remainingMilliseconds: number) => Promise<void>,
  timeoutMilliseconds: number,
): Promise<void> {
  assertReadinessTimeout(timeoutMilliseconds);
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const remainingMilliseconds = deadline - Date.now();
    try {
      await check(remainingMilliseconds);
      if (Date.now() >= deadline) break;
      return;
    } catch {
      const remainingAfterProbe = deadline - Date.now();
      if (remainingAfterProbe <= 0) break;
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(250, remainingAfterProbe)),
      );
    }
  }
  throw new Error("ripwire did not become ready before the startup timeout");
}
