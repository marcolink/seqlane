import { createGunzip, gzipSync } from "node:zlib";
import { addAbortSignal } from "node:stream";
import { z } from "zod";
import {
  reviewMetadataV5Schema,
  reviewStateV5Schema,
  type ReviewMetadataV5,
  type ReviewStateV5,
} from "@seqlane/code-review-workflow/contracts";
import { canonicalReviewJson, reviewSha256 } from "./review-state-canonical.js";
import {
  validateReviewMetadataBindings,
  validateReviewStateBindings,
} from "./review-state-bindings.js";
import { REVIEW_REPORT_MARKER } from "./review-report-identity.js";
import { ReviewScopeError } from "./review-scope-errors.js";

export const REVIEW_STATE_CODEC_LIMITS = Object.freeze({
  encodedCharacters: 20_000,
  compressedBytes: 15_000,
  decodedBytes: 512_000,
});
const envelopeSchema = z.strictObject({
  schemaVersion: z.literal(5),
  encoding: z.literal("gzip+base64"),
  data: z
    .string()
    .min(4)
    .max(REVIEW_STATE_CODEC_LIMITS.encodedCharacters)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
});

function metadataFor(state: ReviewStateV5): ReviewMetadataV5 {
  return reviewMetadataV5Schema.parse({
    schemaVersion: 5,
    repositoryId: state.repositoryId,
    pullRequestNumber: state.pullRequestNumber,
    reviewedRevision: state.reviewedRevision,
    generation: state.scopeCheckpoint.generation,
    stateRevision: state.stateRevision,
    run: {
      id: state.manifestReference.workflowRunId,
      attempt: state.manifestReference.workflowAttempt,
    },
    stateDigest: reviewSha256(canonicalReviewJson(state)),
  });
}

/** Encodes machine state only; no human projection or publication occurs. */
export function encodeReviewStateV5(stateValue: unknown): string {
  try {
    const state = reviewStateV5Schema.parse(stateValue);
    validateReviewStateBindings(state);
    const text = canonicalReviewJson(state);
    if (Buffer.byteLength(text) > REVIEW_STATE_CODEC_LIMITS.decodedBytes)
      throw new Error("Decoded state exceeds byte limit");
    const compressed = gzipSync(text, { level: 9 });
    if (compressed.byteLength > REVIEW_STATE_CODEC_LIMITS.compressedBytes)
      throw new Error("Compressed state exceeds byte limit");
    const envelope = envelopeSchema.parse({
      schemaVersion: 5,
      encoding: "gzip+base64",
      data: compressed.toString("base64"),
    });
    return `${REVIEW_REPORT_MARKER}\n<!-- seqlane-code-review-meta-v5: ${canonicalReviewJson(metadataFor(state))} -->\n<!-- seqlane-code-review-state-v5: ${canonicalReviewJson(envelope)} -->`;
  } catch (cause) {
    if (cause instanceof ReviewScopeError) throw cause;
    throw new ReviewScopeError(
      "REVIEW_STATE_ENCODE_FAILED",
      "Could not encode bounded v5 state.",
      cause,
    );
  }
}

async function expandState(
  compressed: Uint8Array,
  signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted();
  const decoder = createGunzip({ chunkSize: 16_384 });
  if (signal !== undefined) addAbortSignal(signal, decoder);
  const chunks: Buffer[] = [];
  let bytes = 0;
  decoder.end(compressed);
  try {
    for await (const chunkValue of decoder) {
      // Node streams are an isolated platform boundary; validate their chunks.
      const chunk = z.instanceof(Buffer).parse(chunkValue);
      bytes += chunk.byteLength;
      if (bytes > REVIEW_STATE_CODEC_LIMITS.decodedBytes)
        throw new Error("Expanded state exceeds byte limit");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, bytes);
  } finally {
    decoder.destroy();
  }
}

function readStateTransport(body: string) {
  if (Buffer.byteLength(body) > 65_536)
    throw new Error("Comment exceeds byte limit");
  if (body.split(REVIEW_REPORT_MARKER).length !== 2)
    throw new Error("Expected one report marker");
  const metadataBlocks = [
    ...body.matchAll(/^<!-- seqlane-code-review-meta-v5: ([^\r\n]+) -->$/gm),
  ];
  const stateBlocks = [
    ...body.matchAll(/^<!-- seqlane-code-review-state-v5: ([^\r\n]+) -->$/gm),
  ];
  const block = stateBlocks[0];
  const metadataBlock = metadataBlocks[0];
  if (
    block === undefined ||
    metadataBlock === undefined ||
    block.index === undefined ||
    metadataBlocks.length !== 1 ||
    stateBlocks.length !== 1 ||
    body.split("<!-- seqlane-code-review-meta-").length !== 2 ||
    body.split("<!-- seqlane-code-review-state-").length !== 2
  )
    throw new Error("Expected one metadata marker and one hidden state block");
  if (body.slice(block.index + block[0].length).trim() !== "")
    throw new Error("State block must end the report");
  const prefix = body.slice(0, block.index);
  if ([...prefix.matchAll(/^\s*(?:```|~~~)/gm)].length % 2 !== 0)
    throw new Error("State block cannot be inside a Markdown fence");
  const metadataText = z.string().parse(metadataBlock[1]);
  const metadataValue: unknown = JSON.parse(metadataText);
  const metadata = reviewMetadataV5Schema.parse(metadataValue);
  const envelopeText = z.string().parse(block[1]);
  const envelopeValue: unknown = JSON.parse(envelopeText);
  const envelope = envelopeSchema.parse(envelopeValue);
  if (
    canonicalReviewJson(metadata) !== metadataText ||
    canonicalReviewJson(envelope) !== envelopeText
  )
    throw new Error("Metadata or envelope JSON is not canonical");
  const compressed = Buffer.from(envelope.data, "base64");
  if (
    compressed.byteLength > REVIEW_STATE_CODEC_LIMITS.compressedBytes ||
    compressed.toString("base64") !== envelope.data
  )
    throw new Error("Compressed state is oversized or noncanonical");
  return { compressed, metadata };
}

export async function decodeReviewStateV5(
  body: string,
  signal?: AbortSignal,
): Promise<{ state: ReviewStateV5; metadata: ReviewMetadataV5 }> {
  try {
    signal?.throwIfAborted();
    const { compressed, metadata } = readStateTransport(body);
    const decoded = await expandState(compressed, signal);
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(decoded);
    const value: unknown = JSON.parse(text);
    const state = reviewStateV5Schema.parse(value);
    if (canonicalReviewJson(state) !== text)
      throw new Error("State JSON is not canonical");
    validateReviewStateBindings(state);
    validateReviewMetadataBindings(state, metadata);
    return { state, metadata };
  } catch (cause) {
    if (cause instanceof ReviewScopeError) throw cause;
    throw new ReviewScopeError(
      "REVIEW_STATE_DECODE_FAILED",
      "Could not decode trusted bounded v5 state.",
      cause,
    );
  }
}
