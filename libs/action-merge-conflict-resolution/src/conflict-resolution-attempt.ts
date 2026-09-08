import {
  type ConflictPath,
  type ConflictSet,
  type ResolveMergeConflictsPorts,
  type ResolveMergeConflictsRequest,
  type ResolutionAttemptDiagnostics,
  type ResolutionAttemptReport,
} from "./contracts.js";
import { ActionResolutionError } from "./errors.js";
import { classifyConflicts } from "./policy.js";
import type { ResolveMergeConflictsWorkflowOutput } from "@seqlane/runtime/workflows/resolve-merge-conflicts";

const NO_ATTEMPT_DIAGNOSTICS: ResolutionAttemptDiagnostics = {
  eventCount: 0,
  truncated: false,
};

async function regenerateBuiltInLockfile(
  ports: ResolveMergeConflictsPorts,
  conflicts: ConflictSet,
): Promise<void> {
  if (conflicts.length === 0) return;
  if (ports.lockfile === undefined) {
    throw new ActionResolutionError(
      "operational",
      "LOCKFILE_REGENERATION_FAILED",
      "The built-in lockfile handler is not available.",
    );
  }
  await ports.lockfile.regenerate();
}

async function resolveAgentConflicts(
  ports: ResolveMergeConflictsPorts,
  allConflicts: ConflictSet,
  agentConflicts: ConflictSet,
  startAgent: () => Promise<void>,
): Promise<ResolveMergeConflictsWorkflowOutput> {
  const workflowOutput: ResolveMergeConflictsWorkflowOutput = {
    summary: "No model resolution was required.",
    resolvedFiles: allConflicts.map(({ path }) => path),
    decisions: allConflicts.map(({ path }) => ({
      file: path,
      decision: "Resolved mechanically without a model attempt.",
    })),
  };
  if (agentConflicts.length === 0) return workflowOutput;

  await startAgent();
  const agentRequest = await ports.files.prepareAgentWorkspace(agentConflicts);
  const resolved = await ports.agent.resolve(agentRequest);
  await ports.files.copyAgentEdits(agentRequest.paths);
  return resolved;
}

async function runGeneratedHandlers(
  ports: ResolveMergeConflictsPorts,
  generated: ReturnType<typeof classifyConflicts>["generated"],
): Promise<readonly ConflictPath[]> {
  const generatedPaths: ConflictPath[] = [];
  for (const group of generated) {
    generatedPaths.push(
      ...(await ports.generatedFiles.run(group.rule, group.conflicts)),
    );
  }
  return [...new Set(generatedPaths)];
}

export async function resolveConflictAttempt(context: {
  readonly request: ResolveMergeConflictsRequest;
  readonly ports: ResolveMergeConflictsPorts;
  readonly conflicts: ConflictSet;
  readonly attempt: number;
  readonly startAgent: () => Promise<void>;
}): Promise<{
  readonly report: ResolutionAttemptReport;
  readonly remaining: ConflictSet;
}> {
  const { request, ports, conflicts, attempt, startAgent } = context;
  const classified = classifyConflicts(conflicts, request.conflictHandlers);
  const rebaseCommit =
    request.strategy === "rebase"
      ? await ports.git.readRebaseConflictCommit?.()
      : undefined;
  const generatedPaths = await runGeneratedHandlers(
    ports,
    classified.generated,
  );
  const workflowOutput = await resolveAgentConflicts(
    ports,
    conflicts,
    classified.agent,
    startAgent,
  );
  await regenerateBuiltInLockfile(ports, classified.lockfile);
  const report: ResolutionAttemptReport = {
    attempt,
    ...(rebaseCommit === undefined
      ? {}
      : {
          commit: {
            oldSha: rebaseCommit.sha,
            subject: rebaseCommit.subject,
          },
        }),
    summary: workflowOutput.summary,
    decisions: workflowOutput.decisions,
    diagnostics:
      classified.agent.length > 0
        ? (ports.agent.getAttemptDiagnostics?.() ?? NO_ATTEMPT_DIAGNOSTICS)
        : NO_ATTEMPT_DIAGNOSTICS,
  };
  await ports.files.validateTarget(conflicts, generatedPaths);
  await ports.git.stageConflictSet(conflicts, generatedPaths);
  return { report, remaining: await ports.git.readConflictSet() };
}
