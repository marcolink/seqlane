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

export async function checkMcpInitialize(
  url: string,
  token: string | undefined,
  timeoutMilliseconds: number,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  assertReadinessTimeout(timeoutMilliseconds);
  const response = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify(MCP_INITIALIZE_REQUEST),
    signal: AbortSignal.timeout(Math.max(1, Math.floor(timeoutMilliseconds))),
  });
  try {
    const body = await readBody(response, 1_024 * 1_024);
    if (response.status !== 200) {
      throw new Error(`Ripwire MCP readiness returned HTTP ${response.status}`);
    }
    let parsed: unknown;
    try {
      parsed = parseMcpResponseBody(body);
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
    await Promise.resolve(response.body?.cancel()).catch(() => undefined);
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
