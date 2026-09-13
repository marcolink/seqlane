export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_LINE_BYTES = 4 * 1024 * 1024;
export const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
export const MAX_PENDING_MESSAGES = 256;
export const MAX_PENDING_MESSAGE_BYTES = 512 * 1024;
export const MAX_TRANSCRIPT_ENTRIES = 256;
export const MAX_TRANSCRIPT_BYTES = 1 * 1024 * 1024;
export const MAX_OUTBOUND_MESSAGE_BYTES = MAX_LINE_BYTES;
export const MAX_OUTBOUND_PARAMS_BYTES = 2 * 1024 * 1024;
export const SHUTDOWN_GRACE_MS = 1_000;
export const SHUTDOWN_FORCE_SETTLEMENT_MS = 1_000;
export const MAX_STRUCTURED_OUTPUT_BYTES = 16 * 1024;
export const MAX_REQUIRED_OUTPUT_BYTES = 64 * 1024;

export const PROBE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    version: { type: "string" },
  },
  required: ["ok", "version"],
  additionalProperties: false,
};
