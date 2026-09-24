// @test-scope ./publication-guard.ts
import { describe, expect, it } from "vitest";
import { guardPublicationTarget } from "./publication-guard.js";

const input = {
  pullRequestNumber: 83,
  expectedHeadRevision: "a".repeat(40),
  workflowRunId: "workflow-run",
  githubRunId: "10",
  attempt: 1,
};
const report = (overrides: Partial<{ author: string; body: string }> = {}) => ({
  id: "comment-1",
  kind: "issue" as const,
  author: overrides.author ?? "github-actions[bot]",
  authorAssociation: "NONE",
  body:
    overrides.body ??
    `<!-- seqlane-code-review -->\n<!-- seqlane-code-review-meta-v3: {"schemaVersion":3,"pullRequestNumber":83,"reviewedRevision":"${input.expectedHeadRevision}","run":{"id":"9","attempt":1}} -->`,
  createdAt: "2026-09-09T00:00:00Z",
});

describe("publication guard", () => {
  it("replaces a prior report without importing its finding state", () => {
    expect(guardPublicationTarget(report(), input)).toMatchObject({
      status: "eligible",
    });
  });

  it("accepts current metadata and rejects ambiguous version markers", () => {
    const current = report().body.replace(
      'meta-v3: {"schemaVersion":3',
      'meta-v4: {"schemaVersion":4',
    );
    expect(
      guardPublicationTarget(report({ body: current }), input),
    ).toMatchObject({ status: "eligible" });
    expect(
      guardPublicationTarget(
        report({ body: `${current}\n${report().body}` }),
        input,
      ),
    ).toEqual({ status: "stale" });
  });

  it("rejects an unowned, wrong-PR, malformed, or newer same-head report", () => {
    expect(
      guardPublicationTarget(report({ author: "attacker" }), input),
    ).toEqual({ status: "stale" });
    expect(
      guardPublicationTarget(
        report({
          body: report().body.replace(
            '"pullRequestNumber":83',
            '"pullRequestNumber":84',
          ),
        }),
        input,
      ),
    ).toEqual({ status: "stale" });
    expect(
      guardPublicationTarget(
        report({ body: "<!-- seqlane-code-review -->" }),
        input,
      ),
    ).toEqual({ status: "stale" });
    expect(
      guardPublicationTarget(
        report({
          body: report().body.replace('"run":{"id":"9"', '"run":{"id":"11"'),
        }),
        input,
      ),
    ).toEqual({ status: "stale" });
  });
});
