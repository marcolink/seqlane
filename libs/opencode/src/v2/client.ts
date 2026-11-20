import { OpenCode, type OpenCodeClient } from "@opencode/client";
import { OpenCodeV2Error } from "./errors.js";
import { serverInfoSchema } from "./schemas.js";
import { boundedEventBody } from "./event-body.js";

export const OPENCODE_V2_VERSION = "2.1.2";
const responseLimit = 1_048_576;

/** Bounds bytes before SDK decoding, including error responses. */
const boundedFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, { ...init, redirect: "error" });
  if (response.body === null) return response;
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
    return new Response(boundedEventBody(response.body, responseLimit), {
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
};

export function createClient(
  url: string,
  authorization?: string,
): OpenCodeClient {
  return OpenCode.make({
    baseUrl: url,
    fetch: boundedFetch,
    ...(authorization === undefined ? {} : { headers: { authorization } }),
  });
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
