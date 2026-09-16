import type { OutputEvent, RunOutputState } from "./run-view-model.js";

const MAX_PERSISTENT_CHUNKS = 128;

export function outputBytes(output: RunOutputState): number {
  return (
    output.retainedBytes ??
    Buffer.byteLength(output.transient ?? "") +
      output.persistent.reduce(
        (sum, value) => sum + Buffer.byteLength(value),
        0,
      )
  );
}

/** Bound both text bytes and array overhead; truncation is metadata, not payload. */
export function retainOutput(
  output: RunOutputState,
  event: Extract<OutputEvent, { type: "invocation.output" }>,
  available: number,
): RunOutputState {
  const full =
    output.truncated ||
    (event.policy === "persistent" &&
      output.persistent.length >= MAX_PERSISTENT_CHUNKS);
  const budget = full ? 0 : Math.max(0, available);
  const originalBytes = Buffer.byteLength(event.content);
  let content = event.content;
  if (originalBytes > budget) {
    const bytes = Buffer.from(content);
    let end = Math.min(budget, bytes.length);
    while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
    content = bytes.subarray(0, end).toString("utf8");
  }
  const persistent =
    event.policy === "persistent" && content.length > 0
      ? [...output.persistent, content]
      : output.persistent;
  const transient =
    event.policy === "transient" && !full ? content : output.transient;
  const retainedBytes =
    outputBytes(output) +
    (event.policy === "persistent"
      ? Buffer.byteLength(content)
      : Buffer.byteLength(transient ?? "") -
        Buffer.byteLength(output.transient ?? ""));
  return {
    ...output,
    persistent,
    transient,
    retainedBytes,
    truncated: output.truncated || originalBytes > budget,
    metrics: event.metrics ?? output.metrics,
    summary: event.summary ?? output.summary,
  };
}
