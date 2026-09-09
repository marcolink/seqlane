// @test-scope ./publication-workflow.ts
import { startWorkflowRun } from "@seqlane/runtime";
import { describe, expect, it } from "vitest";
import {
  buildPublicationWorkflow,
  type PublicationPort,
} from "./publication-workflow.js";

const baseRevision = "a".repeat(40);
const headRevision = "b".repeat(40);

describe("publicationWorkflow", () => {
  it("runs the frozen review result through local tasks without a model", async () => {
    const published: string[] = [];
    const port: PublicationPort = {
      checkLiveState: async () => "live",
      publishReport: async ({ publication }) => {
        published.push(publication.body);
      },
    };
    const workflow = buildPublicationWorkflow(port);

    expect(workflow.plan.nodes).toHaveLength(5);
    expect(
      workflow.plan.nodes.every(
        (node) => node.type === "task" && node.execution === "local",
      ),
    ).toBe(true);

    const handle = startWorkflowRun({
      workflow,
      input: {
        repository: "owner/repository",
        pullRequestNumber: 1,
        expectedHeadRevision: headRevision,
        existingReportId: "",
        snapshot: {
          report: {
            repository: "owner/repository",
            baseBranch: "main",
            baseRevision,
            verdict: "approve",
            summary: "No blocking findings.",
            findings: [],
            verification: [],
            headRevision,
            pullRequestNumber: 1,
            nextFindingIndex: 1,
            limitations: [],
            stateTruncated: false,
          },
          events: [],
          runId: "review-run",
          completedAt: "2026-09-09T00:00:00.000Z",
        },
      },
      runtime: { id: "local", workspace: "/tmp" },
      events: { emit: () => undefined },
    });

    const outcome = await handle.outcome;
    if (outcome.status === "failed") throw outcome.error;
    expect(outcome).toMatchObject({
      status: "succeeded",
      result: { status: "published", publication: { verdict: "approve" } },
    });
    expect(published).toHaveLength(1);
  });
});
