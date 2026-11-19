import { Effect, Stream } from "effect";
import * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import { z } from "zod";

const MAX_ACK_BYTES = 64 * 1024;
const rejectionCountSchema = z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^\d+$/),
]);
const acknowledgementSchema = z.object({
  partialSuccess: z
    .object({
      rejectedSpans: rejectionCountSchema.optional(),
      rejectedLogRecords: rejectionCountSchema.optional(),
      rejectedDataPoints: rejectionCountSchema.optional(),
      errorMessage: z.string().optional(),
    })
    .optional(),
});

export function readAcknowledgement(
  response: HttpClientResponse.HttpClientResponse,
) {
  return Effect.gen(function* () {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let text = "";
    let bytes = 0;
    yield* Stream.runForEach(response.stream, (chunk) =>
      Effect.try(() => {
        bytes += chunk.byteLength;
        if (bytes > MAX_ACK_BYTES)
          throw new Error("OTLP acknowledgement exceeded its byte limit");
        text += decoder.decode(chunk, { stream: true });
      }),
    ).pipe(
      Effect.catch((error) =>
        HttpClientError.isHttpClientError(error) &&
        error.reason._tag === "EmptyBodyError"
          ? Effect.void
          : Effect.fail(error),
      ),
    );
    yield* Effect.try(() => {
      text += decoder.decode();
    });
    if (text.length === 0) return;
    yield* Effect.try(() => {
      const value: unknown = JSON.parse(text);
      const partial = acknowledgementSchema.parse(value).partialSuccess;
      if (
        partial !== undefined &&
        [
          partial.rejectedSpans,
          partial.rejectedLogRecords,
          partial.rejectedDataPoints,
        ].some((count) => count !== undefined && BigInt(count) > 0n)
      ) {
        throw new Error("OTLP collector rejected telemetry records");
      }
    });
  });
}
