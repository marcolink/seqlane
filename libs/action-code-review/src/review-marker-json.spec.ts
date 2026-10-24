import { describe, expect, it } from "vitest";
import { reviewMarkerJsonSchema } from "./review-marker-json.js";

describe("unambiguous review marker JSON", () => {
  it.each([
    '{"schemaVersion":5,"schemaVersion":4}',
    '{"schemaVersion":4,"\\u0073chemaVersion":4}',
    '{"pullRequestNumber":113,"pullRequestNumber":112}',
    '{"reviewedRevision":"old","reviewedRevision":"new"}',
    '{"nested":{"id":1,"id":2}}',
    '{"runs":[{"id":1,"id":2}]}',
    '{"__proto__":1,"__proto__":2}',
  ])("rejects duplicate decoded keys: %s", (text) => {
    expect(() => reviewMarkerJsonSchema.parse(text)).toThrow("duplicate");
  });
  it("permits the same key in separate objects and ignores syntax inside strings", () => {
    const value = {
      schemaVersion: 4,
      run: { id: 1 },
      runs: [{ id: 2 }, { id: 3 }],
      text: 'brace } and fake "schemaVersion":5 and quote \\',
      'escaped"key': "value",
    };
    expect(reviewMarkerJsonSchema.parse(JSON.stringify(value))).toEqual(value);
  });
  it.each([
    '{"schemaVersion":4,}',
    '{"schemaVersion":"\\q"}',
    '{"schemaVersion":4',
    "{} trailing",
    '"unterminated',
    " ".repeat(65_537),
    null,
  ])("rejects malformed or oversized metadata: %j", (text) => {
    expect(() => reviewMarkerJsonSchema.parse(text)).toThrow();
  });
});
