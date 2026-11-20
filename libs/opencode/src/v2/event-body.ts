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
          if (pendingBoundary) {
            // The held CR belongs to the preceding frame, including an optional LF.
            if (byte === 10) {
              if (++size > limit)
                throw new OpenCodeV2Error(
                  "limit",
                  "event frame exceeded 1 MiB",
                );
              controller.enqueue(Uint8Array.of(13, 10));
              start = index + 1;
            } else controller.enqueue(Uint8Array.of(13));
            size = 0;
            newlines = 0;
            carriageReturn = false;
            pendingBoundary = false;
            if (byte === 10) continue;
          }
          size++;
          if (size > limit)
            throw new OpenCodeV2Error("limit", "event frame exceeded 1 MiB");
          if (byte === 13 || (byte === 10 && !carriageReturn)) newlines++;
          else if (byte !== 10) newlines = 0;
          carriageReturn = byte === 13;
          if (newlines < 2) continue;
          // Hold the final CR so downstream cannot decode a boundary too early.
          const end = byte === 13 ? index : index + 1;
          if (start < end) controller.enqueue(chunk.subarray(start, end));
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
      flush(controller) {
        if (pendingBoundary) controller.enqueue(Uint8Array.of(13));
      },
    }),
  );
}
