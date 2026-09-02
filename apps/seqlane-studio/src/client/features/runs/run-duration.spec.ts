import { describe, expect, it } from "vitest";
import { formatRunDuration } from "./run-duration.js";

describe("formatRunDuration", () => {
  it("formats a completed run duration from its timestamps", () => {
    expect(
      formatRunDuration("2026-08-29T20:00:00.000Z", "2026-08-29T20:01:01.000Z"),
    ).toBe("1m 1s");
  });

  it("returns no duration when the timestamps are absent or invalid", () => {
    expect(formatRunDuration(undefined, undefined)).toBeUndefined();
    expect(
      formatRunDuration("not-a-timestamp", "2026-08-29T20:00:01.000Z"),
    ).toBeUndefined();
  });
});
