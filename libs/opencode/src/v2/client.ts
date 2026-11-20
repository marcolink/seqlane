import { OpenCode, type OpenCodeClient } from "@opencode/client";
import { OpenCodeV2Error } from "./errors.js";
import { serverInfoSchema } from "./schemas.js";
import { boundedEventBody } from "./event-body.js";
import { trackedEventBody } from "./tracked-event-body.js";

export const OPENCODE_V2_VERSION = "2.1.2";
const responseLimit = 1_048_576;

/** Bounds bytes before SDK decoding, including error responses. */
async function boundedFetch(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
  onClosed?: () => void,
) {
  const response = await fetch(input, { ...init, redirect: "error" });
  if (response.body === null) {
    onClosed?.();
    return response;
  }
  const url = new URL(input instanceof Request ? input.url : String(input));
  const streaming =
    (url.pathname === "/api/event" ||
      /^\/api\/experimental\/session\/[^/]+\/log$/.test(url.pathname)) &&
    response.ok &&
    response.headers
      .get("content-type")
      ?.split(";")[0]
      ?.trim()
      .toLowerCase() === "text/event-stream";
  if (streaming) {
    const headers = new Headers(response.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    const body =
      onClosed === undefined
        ? response.body
        : trackedEventBody(response.body, init?.signal, onClosed);
    return new Response(boundedEventBody(body, responseLimit), {
      status: response.status,
      headers,
    });
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > responseLimit)
        throw new OpenCodeV2Error("limit", "response exceeded 1 MiB");
      chunks.push(item.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    onClosed?.();
  }
  const body = Buffer.concat(chunks, length);
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.set("content-length", String(length));
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function createClient(
  url: string,
  authorization?: string,
): OpenCodeClient & { waitForEventStreams(): Promise<void> } {
  const streams = new Set<Promise<void>>();
  const ownedFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname !== "/api/event") return boundedFetch(input, init);
    let resolveClosed: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    streams.add(closed);
    const finish = () => {
      streams.delete(closed);
      resolveClosed();
    };
    try {
      return await boundedFetch(input, init, finish);
    } catch (cause) {
      finish();
      throw cause;
    }
  };
  const client = OpenCode.make({
    baseUrl: url,
    fetch: ownedFetch,
    ...(authorization === undefined ? {} : { headers: { authorization } }),
  });
  return {
    ...client,
    async waitForEventStreams() {
      await Promise.all([...streams]);
    },
  };
}

export type V2Client = ReturnType<typeof createClient>;

export function requestOptions(signal?: AbortSignal) {
  return {
    signal:
      signal === undefined
        ? AbortSignal.timeout(10_000)
        : AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  };
}

export async function verifyServer(
  client: V2Client,
  signal?: AbortSignal,
): Promise<void> {
  const info = serverInfoSchema.parse(
    await client.server.info(requestOptions(signal)),
  );
  if (info.version !== OPENCODE_V2_VERSION) {
    throw new OpenCodeV2Error(
      "compatibility",
      `server version ${info.version} is unsupported; expected ${OPENCODE_V2_VERSION}`,
    );
  }
}
