import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { StudioRunSummary } from "@seqlane/studio/protocol";
import { RunList, writeRunIdToClipboard } from "./run-list.js";

const run = {
  workId: "work-1",
  runId: "88f82d70-b1a4-46dc-acad-630212500d9d",
  workflowId:
    "@seqlane/fixtures/renovate-workflow#renovateWorkflow",
  state: "succeeded",
  isIncomplete: false,
  startedAt: "2026-08-29T20:00:00.000Z",
  finishedAt: "2026-08-29T20:00:01.250Z",
  activeInvocationCount: 0,
  lastEventSequence: 9,
} satisfies StudioRunSummary;

describe("RunList", () => {
  it("shows state, run ID, and an accessible copy action without duplicating the workflow title", () => {
    const markup = renderToStaticMarkup(
      <RunList
        runs={[run]}
        selectedRunId={run.runId}
        onClose={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(markup).toContain("Succeeded");
    expect(markup).toContain("Run ID");
    expect(markup).toContain(run.runId);
    expect(markup).toContain("Duration");
    expect(markup).toContain("1.25 s");
    expect(markup).toContain(`aria-label="Copy run ID ${run.runId}"`);
    expect(markup).toContain("Use the full workspace width");
    expect(markup).toContain("studio-tooltip__content--bottom");
    expect(markup).not.toContain(run.workflowId);
  });

  it("copies the complete run ID", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);

    await writeRunIdToClipboard(run.runId, { writeText });

    expect(writeText).toHaveBeenCalledWith(run.runId);
  });
});
