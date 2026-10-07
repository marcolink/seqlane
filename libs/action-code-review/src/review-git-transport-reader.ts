import { Agent, request as httpsRequest } from "node:https";
import type { IncomingMessage, RequestOptions } from "node:http";
import { z } from "zod";
import {
  ReviewScopeError,
  ReviewScopeLimitError,
} from "./review-scope-errors.js";

export interface ReviewGitTransportRequest {
  readonly url: URL;
  readonly method: "GET" | "POST";
  readonly body?: Uint8Array;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

/** Internal seam for a controlled fixture server, not a target-selected route. */
export type ReviewGitTransport = (
  request: ReviewGitTransportRequest,
) => Promise<IncomingMessage>;

export const requestReviewGitTransport: ReviewGitTransport = (request) =>
  new Promise((resolve, reject) => {
    const agent = new Agent({ keepAlive: false });
    const options: RequestOptions = {
      agent,
      method: request.method,
      headers: request.headers,
      signal: request.signal,
    };
    const outgoing = httpsRequest(request.url, options, resolve);
    outgoing.once("error", (cause) => {
      agent.destroy();
      reject(cause);
    });
    outgoing.once("close", () => agent.destroy());
    outgoing.end(request.body);
  });

/** Response-body bytes, shared across both HTTPS requests. No decompression. */
export async function readMeteredGitResponse(
  response: IncomingMessage,
  contentType: string,
  meter: { bytes: number; readonly limit: number },
): Promise<Buffer> {
  try {
    if (
      response.statusCode !== 200 ||
      response.headers["content-type"]?.split(";")[0] !== contentType ||
      (response.headers["content-encoding"] !== undefined &&
        response.headers["content-encoding"] !== "identity")
    )
      throw new ReviewScopeError(
        "CHECKPOINT_UNAVAILABLE",
        "The trusted Git transport refused the exact checkpoint.",
        { status: response.statusCode },
      );
    const chunks: Buffer[] = [];
    for await (const value of response) {
      const chunk = z.instanceof(Buffer).parse(value);
      meter.bytes += chunk.byteLength;
      if (meter.bytes > meter.limit)
        throw new ReviewScopeLimitError(
          "transferBytes",
          meter.bytes,
          meter.limit,
          "exact-checkpoint-fetch",
        );
      chunks.push(chunk);
    }
    if (!response.complete)
      throw new ReviewScopeError(
        "GIT_FETCH_INCOMPLETE",
        "Git transport ended before the complete response.",
      );
    return Buffer.concat(chunks);
  } finally {
    response.destroy();
  }
}
