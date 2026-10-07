import { gitRevisionSchema } from "./contracts.js";
import {
  readMeteredGitResponse,
  requestReviewGitTransport,
  type ReviewGitTransport,
} from "./review-git-transport-reader.js";
import {
  checkpointFetchBody,
  checkpointPack,
} from "./review-git-pack-protocol.js";
import {
  ReviewScopeError,
  ReviewScopeLimitError,
} from "./review-scope-errors.js";

export async function fetchCheckpointPack(
  remote: { readonly url: string; readonly authorization?: string },
  revision: string,
  limits: { readonly transferBytes: number; readonly wallMs: number },
  signal: AbortSignal,
  transport: ReviewGitTransport = requestReviewGitTransport,
) {
  gitRevisionSchema.parse(revision);
  const meter = { bytes: 0, limit: limits.transferBytes };
  const headers = {
    "Accept-Encoding": "identity",
    "Git-Protocol": "version=1",
    ...(remote.authorization === undefined
      ? {}
      : { Authorization: remote.authorization }),
  };
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), limits.wallMs);
  const boundedSignal = AbortSignal.any([signal, deadline.signal]);
  const started = performance.now();
  const read = async (path: string, type: string, body?: Uint8Array) => {
    const url = new URL(remote.url.replace(/\/$/, "") + path);
    const response = await transport({
      url,
      method: body === undefined ? "GET" : "POST",
      body,
      headers: {
        ...headers,
        ...(body === undefined
          ? {}
          : { "Content-Type": "application/x-git-upload-pack-request" }),
      },
      signal: boundedSignal,
    });
    return readMeteredGitResponse(response, type, meter);
  };
  try {
    const advertisement = await read(
      "/info/refs?service=git-upload-pack",
      "application/x-git-upload-pack-advertisement",
    );
    const body = checkpointFetchBody(advertisement, revision);
    const response = await read(
      "/git-upload-pack",
      "application/x-git-upload-pack-result",
      body,
    );
    return {
      pack: checkpointPack(response),
      transferBytes: meter.bytes,
      wallMs: performance.now() - started,
    };
  } catch (cause) {
    if (cause instanceof ReviewScopeError) throw cause;
    if (deadline.signal.aborted && !signal.aborted)
      throw new ReviewScopeLimitError(
        "commandWallMs",
        performance.now() - started,
        limits.wallMs,
        "exact-checkpoint-fetch",
      );
    throw new ReviewScopeError(
      signal.aborted ? "REVIEW_SCOPE_CANCELLED" : "GIT_FETCH_FAILED",
      "Exact-checkpoint transport failed.",
      cause,
    );
  } finally {
    clearTimeout(timer);
  }
}
