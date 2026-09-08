import { z } from "zod";

export interface ParsedListenAddress {
  readonly host: string;
  readonly port: number;
  readonly listen: string;
  readonly mcpUrl: string;
}

const initializeResponseSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.literal(1),
    result: z
      .object({
        protocolVersion: z.string().min(1),
        capabilities: z.record(z.string(), z.unknown()),
        serverInfo: z
          .object({ name: z.string().min(1), version: z.string().min(1) })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

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

function parseSsePayload(text: string): unknown {
  const dataLines = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  if (dataLines.length === 0) return JSON.parse(text);
  return JSON.parse(dataLines.join("\n"));
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
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify(MCP_INITIALIZE_REQUEST),
    signal: AbortSignal.timeout(3_000),
  });
  try {
    const body = await readBody(response, 1_024 * 1_024);
    if (response.status !== 200) {
      throw new Error(`Ripwire MCP readiness returned HTTP ${response.status}`);
    }
    let parsed: unknown;
    try {
      parsed = parseSsePayload(body);
    } catch (error) {
      throw new Error("Ripwire MCP readiness returned invalid JSON", {
        cause: error,
      });
    }
    const result = initializeResponseSchema.safeParse(parsed);
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
  check: () => Promise<void>,
  timeoutMilliseconds: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      await check();
      return;
    } catch {
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("ripwire did not become ready before the startup timeout");
}
