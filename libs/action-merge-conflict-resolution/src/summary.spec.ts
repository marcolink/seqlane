// @test-scope ./summary.ts

import { describe, expect, it } from "vitest";

import type { ResolveMergeConflictsResult } from "./contracts.js";
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
        },
      ],
    };

    const formatted = formatResolutionSummary(
      resolved,
      { ref: "refs/heads/bad*ref", sha: revision("f") },
      {
        events: [
          {
            type: "task.output",
            output: "FULL_FILE_CONTENT_SHOULD_NOT_APPEAR",
          } as never,
        ],
        truncated: true,
        record: () => undefined,
      },
      report,
    );

    expect(formatted).toContain("bad \\*subject\\* \\[x\\]");
    expect(formatted).toContain("src/\\`secret\\`.ts: bad \\`content\\`");
    expect(formatted).toContain(
      "Diagnostics: 1 bounded event(s); truncated: true",
    );
    expect(formatted).not.toContain("FULL_FILE_CONTENT_SHOULD_NOT_APPEAR");
    expect(formatted).not.toContain('"type":"task.output"');
  });
});
