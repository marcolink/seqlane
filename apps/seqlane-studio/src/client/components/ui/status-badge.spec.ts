import { describe, expect, it } from "vitest";
import { statusGlyph, statusLabel, statusToneClasses } from "./status-badge.js";

describe("status presentation", () => {
  it("provides a stable label and glyph for every invocation state", () => {
    const states = [
      "queued",
      "waiting",
      "active",
      "retrying",
      "succeeded",
      "failed",
      "skipped",
      "cancelled",
    ] as const;

    for (const state of states) {
      expect(statusLabel(state)).toBe(
        state.charAt(0).toUpperCase() + state.slice(1),
      );
      expect(statusGlyph(state)).not.toBe("");
      expect(statusToneClasses[state]).toContain(`status-${state}`);
    }
  });
});
