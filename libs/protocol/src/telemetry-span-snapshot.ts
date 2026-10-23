import { z } from "zod";

const traceIdSchema = z.string().regex(/^(?!0{32})[0-9a-f]{32}$/);
const spanIdSchema = z.string().regex(/^(?!0{16})[0-9a-f]{16}$/);
const nonNegativeIntegerStringSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const spanLinkSchema = z.strictObject({
  traceId: traceIdSchema,
  spanId: spanIdSchema,
  attributes: z.record(z.string(), z.json()).optional(),
});

export const telemetrySpanSnapshotSchema = z.strictObject({
  name: z.string().min(1).max(256),
  traceId: traceIdSchema,
  spanId: spanIdSchema,
  parentSpanId: spanIdSchema.optional(),
  startTimeUnixNano: nonNegativeIntegerStringSchema,
  endTimeUnixNano: nonNegativeIntegerStringSchema,
  kind: z.enum(["internal", "server", "client", "producer", "consumer"]),
  status: z.enum(["ok", "error"]),
  links: z.array(spanLinkSchema).max(128),
  attributes: z.record(z.string(), z.json()),
});

export const telemetrySpanSnapshotFrameSchema = z.strictObject({
  type: z.literal("runner.telemetry.spans"),
  spans: z.array(telemetrySpanSnapshotSchema).max(2_000),
  droppedRecords: z.number().safe().int().min(0),
  queuePressure: z
    .strictObject({
      maxPendingBytes: z.number().safe().int().positive(),
      pendingBytesPeak: z.number().safe().int().min(0),
      capacityWaitsTotal: z.number().safe().int().min(0),
      overflowsTotal: z.number().safe().int().min(0),
    })
    .refine((pressure) => pressure.pendingBytesPeak <= pressure.maxPendingBytes)
    .optional(),
});

export type TelemetrySpanSnapshot = z.infer<typeof telemetrySpanSnapshotSchema>;
export type TelemetrySpanSnapshotFrame = z.infer<
  typeof telemetrySpanSnapshotFrameSchema
>;

const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const telemetryFrameTagSchema = z.object({
  type: z.literal("runner.telemetry.spans"),
});

/** Distinguishes malformed telemetry frames from malformed canonical IPC. */
export function isTelemetrySpanSnapshotFrameCandidate(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const parsed: unknown = JSON.parse(value);
    return telemetryFrameTagSchema.safeParse(parsed).success;
  } catch {
    return false;
  }
}

export function encodeTelemetrySpanSnapshotFrame(
  frame: TelemetrySpanSnapshotFrame,
): string {
  const parsed = telemetrySpanSnapshotFrameSchema.parse(frame);
  const encoded = JSON.stringify(parsed);
  if (Buffer.byteLength(encoded, "utf8") > MAX_FRAME_BYTES) {
    throw new RangeError("Telemetry span snapshot exceeded its byte limit");
  }
  return encoded;
}

export function decodeTelemetrySpanSnapshotFrame(
  value: unknown,
): TelemetrySpanSnapshotFrame {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > MAX_FRAME_BYTES
  ) {
    throw new TypeError("Invalid telemetry span snapshot frame");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("Invalid telemetry span snapshot frame");
  }
  return telemetrySpanSnapshotFrameSchema.parse(parsed);
}
