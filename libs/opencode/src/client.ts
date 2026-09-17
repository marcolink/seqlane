import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2";
import { OpenCodeExecutorError } from "./errors.js";

const maxMonitorResponseBytes = 256 * 1_024;
const monitorEndpointPattern =
  /^\/api\/session\/[^/]+\/(?:history|permission|question)$/;

async function boundedMonitorResponse(response: Response): Promise<Response> {
  if (response.body === null) return response;
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > maxMonitorResponseBytes
  ) {
    throw new OpenCodeExecutorError(
      `OpenCode monitor response exceeded ${maxMonitorResponseBytes} bytes`,
    );
  }

  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let length = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.byteLength;
    if (length > maxMonitorResponseBytes) {
      await reader.cancel();
      throw new OpenCodeExecutorError(
        `OpenCode monitor response exceeded ${maxMonitorResponseBytes} bytes`,
      );
    }
    chunks.push(chunk.value);
  }

  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.set("content-length", String(length));
  return new Response(body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

const boundedOpenCodeFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const response = await globalThis.fetch(request);
  return monitorEndpointPattern.test(new URL(request.url).pathname)
    ? boundedMonitorResponse(response)
    : response;
};

/** Internal SDK client construction. The SDK client never crosses Seqlane's public boundary. */
export function createOpenCodeClient(
  url: string,
  authorization?: string,
): OpencodeClient {
  return createOpencodeClient({
    baseUrl: url,
    fetch: boundedOpenCodeFetch,
    ...(authorization === undefined ? {} : { headers: { authorization } }),
  });
}
