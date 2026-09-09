// @test-scope ./publication.ts
import { describe, expect, it } from "vitest";
import { derivePublication } from "./publication.js";

describe("model-free publication", () => {
  it("renders a bounded report from frozen data", () => {
    const result = derivePublication({ report: { verdict: "approve", summary: "No issues.", findings: [], headRevision: "a".repeat(40) }, runId: "run-1", events: [{ type: "run.started", workId: "work-1", runId: "run-1" }, { type: "run.succeeded", workId: "work-1", runId: "run-1", output: null }] });
    expect(result.publication.body).toContain("seqlane-code-review");
    expect(result.metrics.runId).toBe("run-1");
  });
});
