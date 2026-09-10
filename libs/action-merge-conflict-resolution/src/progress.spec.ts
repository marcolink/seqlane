// @test-scope ./progress.ts

import { describe, expect, it } from "vitest";

import { createProgressWriter, formatProgressEvent } from "./progress.js";
import { REDACTED_VALUE, createSecretRedactor } from "./recording.js";

describe("resolution progress", () => {
  it("renders compact rebase facts without raw commit details", () => {
    expect(
      formatProgressEvent(
        {
          kind: "started",
          strategy: "rebase",
          maxAttempts: 10,
          commitsToReplay: 14,
        },
        (value) => value,
      ),
    ).toBe("Rebase plan: 14 commits to replay; max 10 resolution passes.");
    expect(
      formatProgressEvent(
        {
          kind: "attempt-started",
          strategy: "rebase",
          attempt: 2,
          maxAttempts: 10,
          conflictStops: 1,
          commit: {
            sha: "a".repeat(40),
            subject: "Fix parser imports",
          },
        },
        (value) => value,
      ),
    ).toBe("Resolution pass 2/10; rebase commit aaaaaaa Fix parser imports");
  });

  it("redacts, strips control characters, and bounds commit subjects", () => {
    const lines: string[] = [];
    const writer = createProgressWriter(
      (line) => lines.push(line),
      createSecretRedactor("secret-token"),
    );
    writer.write({
      kind: "attempt-started",
      strategy: "rebase",
      attempt: 1,
      maxAttempts: 1,
      conflictStops: 1,
      commit: {
        sha: "b".repeat(40),
        subject: `secret-token\u009b\n${"x".repeat(300)}`,
      },
    });

    expect(lines[0]).toContain(REDACTED_VALUE);
    expect(lines[0]).not.toContain("secret-token");
    expect(lines[0]).not.toContain("\u009b");
    expect(lines[0]).not.toMatch(/[\r\n]/);
    expect(lines[0]?.length).toBeLessThanOrEqual(220);
  });

  it("keeps merge output free of rebase-only commit counts", () => {
    expect(
      formatProgressEvent(
        {
          kind: "started",
          strategy: "merge",
          maxAttempts: 10,
        },
        (value) => value,
      ),
    ).toBe("Merge resolution started; max 10 resolution passes.");
    expect(
      formatProgressEvent(
        { kind: "conflict-stop", strategy: "merge", conflictStops: 1 },
        (value) => value,
      ),
    ).toBe("Merge conflict set 1.");
  });
});
