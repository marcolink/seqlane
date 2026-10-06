import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { classifyReviewReport } from "./review-report-classification.js";
import { encodeReviewStateV5 } from "./review-state-codec.js";
import {
  createReviewStateFixture,
  reviewReportFixture,
} from "./review-state-fixture.test-support.js";
import { canonicalReviewJson } from "./review-state-canonical.js";

const context = { repositoryId: "1", pullRequestNumber: 112 };
function history(body: string) {
  return { comments: [reviewReportFixture(body)], truncated: false };
}

describe("strict report version routing", () => {
  it("has mutually exclusive absent, legacy, current, and invalid outcomes", async () => {
    expect(
      await classifyReviewReport({ comments: [], truncated: false }, context),
    ).toEqual({ kind: "absent" });
    const body = encodeReviewStateV5(createReviewStateFixture());
    expect(await classifyReviewReport(history(body), context)).toMatchObject({
      kind: "current",
      reportId: "42",
    });
    expect(
      await classifyReviewReport(
        history(body.replace('"schemaVersion":5', '"schemaVersion":4')),
        context,
      ),
    ).toMatchObject({ kind: "invalid-current" });
  });
  it.each([1, 2, 3, 4])(
    "uses only the v%s marker identity, even without a readable state block",
    async (schemaVersion) => {
      const marker = `<!-- seqlane-code-review-meta-v${schemaVersion}: ${JSON.stringify({ schemaVersion, pullRequestNumber: 112, reviewedRevision: "a".repeat(40), ignored: { findings: ["old-id"], checkpoint: "missing" } })} -->`;
      const classified = await classifyReviewReport(
        history(`<!-- seqlane-code-review -->\n${marker}\nmalformed state`),
        context,
      );
      expect(classified).toMatchObject({
        kind: "legacy",
        legacyMarker: { schemaVersion },
      });
      expect(classified).not.toHaveProperty("state");
    },
  );
  it.each([
    "<!-- seqlane-code-review-meta-v5: {} -->",
    '<!-- seqlane-code-review-meta-v4: {"schemaVersion":4,"pullRequestNumber":113,"reviewedRevision":"' +
      "a".repeat(40) +
      '"} -->',
    '<!-- seqlane-code-review-meta-v4: {"schemaVersion":4,"pullRequestNumber":112,"reviewedRevision":"abbreviated"} -->',
    '<!-- seqlane-code-review-meta-v4: {"schemaVersion":4,"pullRequestNumber":112,"reviewedRevision":"' +
      "a".repeat(40) +
      '"} -->\n<!-- seqlane-code-review-meta-v4: malformed -->',
    '<!-- seqlane-code-review-meta-v0: {"schemaVersion":0,"pullRequestNumber":112,"reviewedRevision":"' +
      "a".repeat(40) +
      '"} -->',
    '<!-- seqlane-code-review-meta-v6: {"schemaVersion":6,"pullRequestNumber":112,"reviewedRevision":"' +
      "a".repeat(40) +
      '"} -->',
  ])(
    "never relabels malformed or unsupported identity as absence",
    async (marker) => {
      expect(
        await classifyReviewReport(
          history(`<!-- seqlane-code-review -->\n${marker}`),
          context,
        ),
      ).toMatchObject({ kind: "invalid-current" });
    },
  );
  it("requires a manifest reference even when marker identity appears current", async () => {
    const state = createReviewStateFixture();
    const withoutReference = Object.fromEntries(
      Object.entries(state).filter(([key]) => key !== "manifestReference"),
    );
    const payload = gzipSync(canonicalReviewJson(withoutReference)).toString(
      "base64",
    );
    const body = encodeReviewStateV5(state).replace(
      /("data":")[^"]+/,
      `$1${payload}`,
    );
    expect(await classifyReviewReport(history(body), context)).toMatchObject({
      kind: "invalid-current",
    });
  });
});
