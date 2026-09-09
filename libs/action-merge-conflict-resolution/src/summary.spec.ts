// @test-scope ./summary.ts

import { describe, expect, it } from "vitest";

import type { ResolveMergeConflictsResult } from "./contracts.js";
import { createBoundedRecording } from "./recording.js";
import {
  formatResolutionSummary,
  type ResolutionSummaryReport,
} from "./summary.js";

const revision = (letter: string): string => letter.repeat(40);

const resolved: ResolveMergeConflictsResult = {
  kind: "resolved",
  result: "updated",
  strategy: "rebase",
  baseSha: revision("a"),
  headSha: revision("b"),
  attempts: 2,
  pushed: false,
};

describe("resolution summary", () => {
  it("renders one human-readable section per rebase attempt", () => {
    const report: ResolutionSummaryReport = {
      strategy: "rebase",
      attempts: [
        {
          attempt: 1,
          commit: {
            oldSha: revision("c"),
            subject: "Add parser",
          },
          summary: "Kept the parser changes and updated the import.",
          decisions: [
            {
              file: "src/parser.ts",
              decision: "Kept both compatible branches.",
            },
          ],
          diagnostics: { eventCount: 2, truncated: false },
        },
        {
          attempt: 2,
          commit: { oldSha: revision("e"), subject: "Fix tests" },
          summary: "Resolved the test fixture conflict.",
          decisions: [
            {
              file: "test/parser.test.ts",
              decision: "Used the newer fixture.",
            },
          ],
          diagnostics: { eventCount: 1, truncated: true },
        },
      ],
    };

    const formatted = formatResolutionSummary(
      resolved,
      undefined,
      undefined,
      report,
    );

    expect(formatted).toContain(
      "### Rebase resolution 1: ccccccc — Add parser",
    );
    expect(formatted).toContain("### Rebase resolution 2: eeeeeee — Fix tests");
    expect(formatted).toContain(
      "Model summary: Kept the parser changes and updated the import.",
    );
    expect(formatted).toContain(
      "src/parser.ts: Kept both compatible branches.",
    );
  });

  it("renders one merge resolution section", () => {
    const report: ResolutionSummaryReport = {
      strategy: "merge",
      attempts: [
        {
          attempt: 1,
          summary: "Merged the compatible configuration changes.",
          decisions: [
            { file: "config.ts", decision: "Combined both settings." },
          ],
          diagnostics: { eventCount: 0, truncated: false },
        },
      ],
    };

    const formatted = formatResolutionSummary(
      { ...resolved, strategy: "merge", attempts: 1 },
      undefined,
      undefined,
      report,
    );

    expect(formatted).toContain("### Merge resolution");
    expect(formatted.match(/### Merge resolution/g)).toHaveLength(1);
    expect(formatted).toContain(
      "Model summary: Merged the compatible configuration changes.",
    );
  });

  it("escapes untrusted Markdown and omits raw recording payloads", () => {
    const report: ResolutionSummaryReport = {
      strategy: "rebase",
      attempts: [
        {
          attempt: 1,
          commit: { oldSha: revision("c"), subject: "bad *subject* [x]" },
          summary: "bad *summary* with [markdown]",
          decisions: [{ file: "src/`secret`.ts", decision: "bad `content`" }],
          diagnostics: { eventCount: 1, truncated: false },
        },
      ],
    };

    const recording = createBoundedRecording(undefined);
    recording.record({
      type: "task.output",
      output: "FULL_FILE_CONTENT_SHOULD_NOT_APPEAR",
    } as never);
    const formatted = formatResolutionSummary(
      resolved,
      { ref: "refs/heads/bad*ref", sha: revision("f") },
      recording,
      report,
    );

    expect(formatted).toContain("bad \\*subject\\* \\[x\\]");
    expect(formatted).toContain("src/\\`secret\\`.ts: bad \\`content\\`");
    expect(formatted).toContain(
      "Diagnostics: 1 bounded event(s); truncated: false",
    );
    expect(formatted).not.toContain("FULL_FILE_CONTENT_SHOULD_NOT_APPEAR");
    expect(formatted).not.toContain('"type":"task.output"');
  });

  it("redacts configured secrets before Markdown escaping and publication", () => {
    const secret = "summary-secret";
    const formatted = formatResolutionSummary(
      resolved,
      undefined,
      createBoundedRecording(secret),
      {
        strategy: "rebase",
        attempts: [
          {
            attempt: 1,
            summary: `model contains ${secret}`,
            decisions: [{ file: "src/file.ts", decision: `used ${secret}` }],
            diagnostics: { eventCount: 0, truncated: false },
          },
        ],
      },
    );

    expect(formatted).not.toContain(secret);
    expect(formatted).toContain("\\[REDACTED\\]");
  });

  it("sanitizes Unicode control characters in the final summary", () => {
    const formatted = formatResolutionSummary(
      resolved,
      undefined,
      undefined,
      {
        strategy: "rebase",
        attempts: [
          {
            attempt: 1,
            summary: "summary before\u009bafter",
            decisions: [],
            diagnostics: { eventCount: 0, truncated: false },
          },
        ],
      },
    );

    expect(formatted).toContain("Model summary: summary before after");
    expect(formatted).not.toContain("\u009b");
  });

  it("keeps the complete summary within the declared total budget", async () => {
    const report: ResolutionSummaryReport = {
      strategy: "rebase",
      attempts: Array.from({ length: 20 }, (_, attempt) => ({
        attempt: attempt + 1,
        summary: "s".repeat(1_000),
        decisions: Array.from({ length: 200 }, (_, index) => ({
          file: `src/file-${index}.ts`,
          decision: "d".repeat(2_000),
        })),
        diagnostics: { eventCount: 128, truncated: true },
      })),
    };

    const formatted = formatResolutionSummary(
      resolved,
      undefined,
      undefined,
      report,
    );

    const { MAX_SUMMARY_TOTAL_CHARS } = await import("./summary.js");
    expect(formatted.length).toBeLessThanOrEqual(MAX_SUMMARY_TOTAL_CHARS);
    expect(formatted).toContain("Summary truncated:");
  });
});
