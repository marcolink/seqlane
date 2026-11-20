import { OpenCodeV2Error } from "./errors.js";

/** Bound each SSE frame in bytes and split coalesced frames before SDK decoding. */
export function boundedEventBody(
  body: ReadableStream<Uint8Array>,
  limit: number,
) {
  let size = 0;
  let newlines = 0;
  let carriageReturn = false;
  let pendingBoundary = false;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        let start = 0;
        for (let index = 0; index < chunk.byteLength; index++) {
          const byte = chunk[index];
          if (pendingBoundary && byte !== 10) {
            size = 0;
            newlines = 0;
            carriageReturn = false;
            pendingBoundary = false;
          }
          size++;
          if (size > limit)
            throw new OpenCodeV2Error("limit", "event frame exceeded 1 MiB");
          if (byte === 13 || (byte === 10 && !carriageReturn)) newlines++;
          else if (byte !== 10) newlines = 0;
          carriageReturn = byte === 13;
          if (newlines < 2) continue;
          controller.enqueue(chunk.subarray(start, index + 1));
          start = index + 1;
          // A blank CR line can still own an LF in the next network chunk.
          pendingBoundary = byte === 13;
          if (pendingBoundary) continue;
          size = 0;
          newlines = 0;
          pendingBoundary = false;
        }
        if (start < chunk.byteLength) controller.enqueue(chunk.subarray(start));
      },
    }),
  );
}
