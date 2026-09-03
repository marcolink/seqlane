import { readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { basename, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeSeqlaneRecording, MAX_RECORDING_BYTES } from "@seqlane/events";
import {
  studioProtocolVersion,
  type StudioApiError,
  type StudioIngestEvent,
  type StudioReplayPayload,
  type StudioStreamEvent,
} from "./protocol.js";
import { StudioRegistry, StudioRegistryError } from "./registry.js";

export { StudioRegistry } from "./registry.js";

const loopbackHost = "127.0.0.1";
export const defaultStudioPort = 57694;

export interface StudioSessionOptions {
  readonly port?: number;
  readonly clientRoot?: string;
  readonly registry?: StudioRegistry;
  readonly replayFile?: string;
}

export interface StudioSession {
  readonly address: string;
  readonly browserUrl: string;
  stop(): Promise<void>;
}

interface InternalSession extends StudioSession {
  readonly server: Server;
}

type LoadedReplay = StudioReplayPayload;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function apiError(
  response: ServerResponse,
  status: number,
  code: StudioApiError["error"]["code"],
  message: string,
): void {
  json(response, status, {
    error: { code, message },
  } satisfies StudioApiError);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_048_576) {
      throw new StudioRegistryError(
        "INVALID_REQUEST",
        "Studio request body is too large",
      );
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new StudioRegistryError(
      "INVALID_REQUEST",
      "Studio request body must be valid JSON",
    );
  }
}

function isStudioIngestEvent(value: unknown): value is StudioIngestEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { workflowId?: unknown }).workflowId === "string" &&
    Object.hasOwn(value, "event")
  );
}

function writeSseEvent(
  response: ServerResponse,
  event: StudioStreamEvent,
): void {
  response.write(`id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`);
}

function writeSseReset(response: ServerResponse, cursor: number): void {
  response.write(
    `event: stream.reset\nid: ${cursor}\ndata: ${JSON.stringify({ type: "stream.reset", cursor })}\n\n`,
  );
}

function lastEventCursor(request: IncomingMessage): number | undefined {
  const value = request.headers["last-event-id"];
  if (value === undefined) return undefined;
  const parsed = Number(Array.isArray(value) ? value[0] : value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new StudioRegistryError(
      "INVALID_REQUEST",
      "Last-Event-ID must be a non-negative integer",
    );
  }
  return parsed;
}

function requestPath(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", "http://127.0.0.1");
}

async function serveStatic(
  response: import("node:http").ServerResponse,
  pathname: string,
  clientRoot: string,
): Promise<void> {
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const candidate = resolve(clientRoot, normalize(relativePath));
  if (!candidate.startsWith(resolve(clientRoot))) {
    response.writeHead(404);
    response.end();
    return;
  }

  try {
    const file = await readFile(candidate);
    const contentType = candidate.endsWith(".html")
      ? "text/html; charset=utf-8"
      : candidate.endsWith(".js")
        ? "text/javascript; charset=utf-8"
        : candidate.endsWith(".css")
          ? "text/css; charset=utf-8"
          : "application/octet-stream";
    response.writeHead(200, { "content-type": contentType });
    response.end(file);
  } catch {
    if (pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><html><body><main>Seqlane Studio is ready.</main></body></html>",
      );
      return;
    }
    response.writeHead(404);
    response.end();
  }
}

function listen(server: Server, port: number): Promise<{ port: number }> {
  return new Promise((resolvePromise, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Studio did not expose a TCP address"));
        return;
      }
      resolvePromise({ port: address.port });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, loopbackHost);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
}

async function loadReplay(path: string): Promise<LoadedReplay> {
  let file;
  try {
    file = await stat(path);
  } catch (error) {
    throw new Error("Could not read replay recording", { cause: error });
  }
  if (!file.isFile())
    throw new Error("Replay recording must be a regular file");
  if (file.size > MAX_RECORDING_BYTES) {
    throw new Error("Replay recording byte limit exceeded");
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    throw new Error("Could not read replay recording", { cause: error });
  }
  if (bytes.byteLength > MAX_RECORDING_BYTES) {
    throw new Error("Replay recording byte limit exceeded");
  }

  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error("Replay recording must be valid UTF-8", { cause: error });
  }
  const recording = decodeSeqlaneRecording(content);
  const replayId = randomUUID();
  const events: StudioStreamEvent[] = recording.events.map((event, index) => ({
    cursor: index + 1,
    workflowId: recording.header.workflowId,
    event,
  }));
  return {
    replayId,
    workflowId: recording.header.workflowId,
    fileName: basename(path),
    events,
  };
}

function replayIdFromPath(pathname: string): string | undefined {
  const prefix = "/api/replay/";
  if (!pathname.startsWith(prefix)) return undefined;
  try {
    return decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    return undefined;
  }
}

export async function startStudioSession(
  options: StudioSessionOptions = {},
): Promise<StudioSession> {
  const registry = options.registry ?? new StudioRegistry();
  const replay =
    options.replayFile === undefined
      ? undefined
      : await loadReplay(options.replayFile);
  const sseClients = new Set<ServerResponse>();
  const clientRoot =
    options.clientRoot ?? fileURLToPath(new URL("./client/", import.meta.url));
  const server = createServer(async (request, response) => {
    const url = requestPath(request);

    if (url.pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }

    if (url.pathname === "/health") {
      json(response, 200, {
        status: "ok",
        protocolVersion: studioProtocolVersion,
      });
      return;
    }

    if (url.pathname === "/api/runs" && request.method === "GET") {
      json(response, 200, registry.listRuns());
      return;
    }

    const replayId = replayIdFromPath(url.pathname);
    if (replayId !== undefined && request.method === "GET") {
      if (replay === undefined || replay.replayId !== replayId) {
        apiError(response, 404, "NOT_FOUND", "Replay not found");
        return;
      }
      json(response, 200, replay);
      return;
    }

    if (url.pathname.startsWith("/api/runs/") && request.method === "GET") {
      try {
        json(
          response,
          200,
          registry.getRun(decodeURIComponent(url.pathname.slice(10))),
        );
      } catch (error) {
        if (
          error instanceof StudioRegistryError &&
          error.code === "NOT_FOUND"
        ) {
          apiError(response, 404, "NOT_FOUND", error.message);
          return;
        }
        apiError(response, 400, "INVALID_REQUEST", errorMessage(error));
      }
      return;
    }

    if (url.pathname === "/api/events" && request.method === "POST") {
      try {
        const body = await readJsonBody(request);
        if (!isStudioIngestEvent(body)) {
          throw new StudioRegistryError(
            "INVALID_REQUEST",
            "Studio ingest requires workflowId and event",
          );
        }
        json(response, 202, registry.ingest(body));
      } catch (error) {
        const status =
          error instanceof StudioRegistryError && error.code === "NOT_FOUND"
            ? 404
            : 400;
        apiError(
          response,
          status,
          error instanceof StudioRegistryError ? error.code : "INVALID_REQUEST",
          errorMessage(error),
        );
      }
      return;
    }

    if (url.pathname === "/api/events" && request.method === "GET") {
      try {
        const cursor = lastEventCursor(request);
        response.writeHead(200, {
          "cache-control": "no-cache",
          connection: "keep-alive",
          "content-type": "text/event-stream; charset=utf-8",
        });
        response.flushHeaders();
        const replay = registry.replayAfter(cursor);
        if (replay.reset) {
          writeSseReset(response, registry.currentCursor);
        } else {
          for (const event of replay.events) writeSseEvent(response, event);
        }
        sseClients.add(response);
        let closed = false;
        let cleanup = () => undefined;
        const unsubscribe = registry.subscribe((event) => {
          if (closed) return;
          try {
            writeSseEvent(response, event);
          } catch {
            cleanup();
          }
        });
        const keepalive = setInterval(() => {
          if (!closed) response.write(": keepalive\n\n");
        }, 15_000);
        cleanup = () => {
          if (closed) return;
          closed = true;
          clearInterval(keepalive);
          unsubscribe();
          sseClients.delete(response);
        };
        request.once("close", cleanup);
        response.once("close", cleanup);
      } catch (error) {
        apiError(response, 400, "INVALID_REQUEST", errorMessage(error));
      }
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      apiError(response, 404, "NOT_FOUND", "Studio endpoint not found");
      return;
    }

    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET" });
      response.end();
      return;
    }

    await serveStatic(response, url.pathname, clientRoot);
  });

  try {
    const { port } = await listen(server, options.port ?? defaultStudioPort);
    const address = `http://${loopbackHost}:${port}`;

    let stopped = false;
    const session: InternalSession = {
      address,
      browserUrl:
        replay === undefined
          ? `${address}/`
          : `${address}/?replay=${encodeURIComponent(replay.replayId)}&debug=1`,
      server,
      async stop() {
        if (stopped) return;
        stopped = true;
        for (const response of sseClients) response.destroy();
        registry.clear();
        await close(server);
      },
    };
    return session;
  } catch (error) {
    await close(server).catch(() => undefined);
    throw error;
  }
}

export async function isLoopbackStudioAddress(
  address: string,
): Promise<boolean> {
  try {
    const url = new URL(address);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "127.0.0.1" ||
        url.hostname === "[::1]" ||
        url.hostname === "::1")
    );
  } catch {
    return false;
  }
}
