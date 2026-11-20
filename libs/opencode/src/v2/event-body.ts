import { OpenCodeV2Error } from "./errors.js";

/** Bound each SSE frame in bytes and split coalesced frames before SDK decoding. */
export function boundedEventBody(body: ReadableStream<Uint8Array>) {
  let size = 0;
  let newlines = 0;
  let carriageReturn = false;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        let start = 0;
        for (let index = 0; index < chunk.byteLength; index++) {
          size++;
          if (size > 1_048_576)
            throw new OpenCodeV2Error("limit", "event frame exceeded 1 MiB");
          const byte = chunk[index];
          if (byte === 13 || (byte === 10 && !carriageReturn)) newlines++;
          else if (byte !== 10) newlines = 0;
          carriageReturn = byte === 13;
          if (newlines < 2) continue;
          controller.enqueue(chunk.subarray(start, index + 1));
          start = index + 1;
          size = 0;
          newlines = 0;
        }
        if (start < chunk.byteLength) controller.enqueue(chunk.subarray(start));
      },
    }),
  );
}
