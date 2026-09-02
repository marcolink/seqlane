import {
  createFlow,
  defineTask,
  defineValidator,
  validatedBy,
} from "@seqlane/core";
import { z } from "zod";
import {
  createReleaseDoctorCheckTask,
  releaseDoctorFindingSchema,
  releaseDoctorRepositorySnapshotSchema,
} from "./release-doctor-check-task.ts";

const releaseDoctorInputSchema = z.object({
  repository: z.string().min(1),
  baseBranch: z.string().min(1),
});

const releaseDoctorStateSchema = z.object({
  repository: z.string(),
  baseBranch: z.string(),
  checks: z.array(releaseDoctorFindingSchema),
  openFindings: z.array(releaseDoctorFindingSchema),
  resolvedFindings: z.array(z.string()),
  healthy: z.boolean(),
  iteration: z.number().int().nonnegative(),
});

const releaseDoctorReportSchema = z.object({
  repository: z.string(),
  baseBranch: z.string(),
  healthy: z.boolean(),
  summary: z.string(),
  checks: z.array(releaseDoctorFindingSchema),
  openFindings: z.array(releaseDoctorFindingSchema),
  resolvedFindings: z.array(z.string()),
  iterations: z.number().int().nonnegative(),
});

const releaseReadinessValidator = defineValidator({
  id: "release-doctor.readiness",
  input: releaseDoctorStateSchema,
  validate: ({ healthy, openFindings }) =>
    healthy && openFindings.length === 0
      ? { success: true }
      : {
          success: false,
          issues: [
            {
              code: "release-not-ready",
              message: "Release readiness still has open findings",
              path: "/openFindings",
            },
          ],
          evidence: { openFindings: openFindings.length },
        },
});

const inspectRepositoryTask = defineTask({
  id: "release-doctor.inspect",
  workspace: "shared",
  input: releaseDoctorInputSchema,
  output: releaseDoctorRepositorySnapshotSchema,
  goal: ({ repository, baseBranch }) =>
    `Inspect the repository at ${repository} relative to ${baseBranch}.`,
  instructions: [
    "Do not modify files, commit, or push.",
    "Identify the package manager and changed files relevant to release readiness.",
    "Return only the structured repository snapshot.",
  ],
  observability: {
    studio: {
      result: {
        includePaths: [
          "/repository",
          "/baseBranch",
          "/packageManager",
          "/changedFiles",
        ],
      },
    },
  },
});

const testsTask = createReleaseDoctorCheckTask({
  id: "release-doctor.tests",
  goal: ({ snapshot }) =>
    `Assess test and typecheck readiness for ${snapshot.repository}.`,
});

const dependenciesTask = createReleaseDoctorCheckTask({
  id: "release-doctor.dependencies",
  goal: ({ snapshot }) =>
    `Assess dependency and lockfile readiness for ${snapshot.repository}.`,
});

const documentationTask = createReleaseDoctorCheckTask({
  id: "release-doctor.documentation",
  goal: ({ snapshot }) =>
    `Assess documentation alignment for ${snapshot.repository}.`,
});

const boundariesTask = createReleaseDoctorCheckTask({
  id: "release-doctor.boundaries",
  goal: ({ snapshot }) =>
    `Assess architecture and package-boundary readiness for ${snapshot.repository}.`,
});

const aggregateInputSchema = z.object({
  snapshot: releaseDoctorRepositorySnapshotSchema,
  tests: releaseDoctorFindingSchema,
  dependencies: releaseDoctorFindingSchema,
  documentation: releaseDoctorFindingSchema,
  boundaries: releaseDoctorFindingSchema,
});

const aggregateFindingsTask = defineTask({
  id: "release-doctor.aggregate",
  workspace: "shared",
  input: aggregateInputSchema,
  output: releaseDoctorStateSchema,
  goal: ({ snapshot }) =>
    `Aggregate release-readiness findings for ${snapshot.repository}.`,
  instructions: [
    "Treat fail findings as open remediation work; preserve warnings as risks.",
    "Set healthy to true only when no finding has fail status.",
    "Start iteration at zero and return the complete structured state.",
  ],
  observability: {
    studio: {
      result: {
        includePaths: ["/healthy", "/openFindings", "/resolvedFindings"],
      },
    },
  },
});

const applySafeRemediationTask = defineTask({
  id: "release-doctor.apply-remediation",
  workspace: "exclusive",
  input: releaseDoctorStateSchema,
  output: releaseDoctorStateSchema,
  goal: ({ repository }) =>
    `Apply at most one safe release-readiness remediation in ${repository}.`,
  instructions: [
    "Modify only the smallest safe change that addresses one open finding.",
    "Never commit, push, delete broad data, or change unrelated files.",
    "If no safe remediation exists, return the state unchanged.",
    "Increment iteration and return the complete structured state.",
  ],
  observability: {
    studio: {
      input: { includePaths: ["/openFindings", "/iteration"] },
      result: { includePaths: ["/openFindings", "/iteration"] },
    },
  },
});

const verifyReleaseReadinessTask = defineTask({
  id: "release-doctor.verify-remediation",
  workspace: "shared",
  input: releaseDoctorStateSchema,
  output: releaseDoctorStateSchema,
  goal: ({ repository }) =>
    `Verify release readiness after remediation in ${repository}.`,
  instructions: [
    "Recheck the affected release-readiness findings.",
    "Preserve unresolved findings and record resolved finding names.",
    "Set healthy to true only when no finding has fail status.",
    "Return the complete structured state without committing or pushing.",
  ],
  observability: {
    studio: {
      result: { includePaths: ["/healthy", "/openFindings", "/iteration"] },
    },
  },
});

const publishReleaseReportTask = defineTask({
  id: "release-doctor.report",
  workspace: "shared",
  input: releaseDoctorStateSchema,
  output: releaseDoctorReportSchema,
  goal: ({ repository }) =>
    `Produce the final release-readiness report for ${repository}.`,
  instructions: [
    "Summarize passing checks, unresolved risks, and applied remediations.",
    "Do not modify files, commit, or push.",
    "Return only the structured release-readiness report.",
  ],
  observability: {
    studio: {
      result: {
        includePaths: ["/healthy", "/summary", "/openFindings", "/iterations"],
      },
    },
  },
});

export default createFlow({
  id: "repository-release-doctor",
  input: releaseDoctorInputSchema,
  output: releaseDoctorReportSchema,
})
  .task("inspect", inspectRepositoryTask, ({ input }) => input)
  .task("tests", testsTask, ({ tasks }) => ({
    snapshot: tasks.inspect.output,
  }))
  .task("dependencies", dependenciesTask, ({ tasks }) => ({
    snapshot: tasks.inspect.output,
  }))
  .task("documentation", documentationTask, ({ tasks }) => ({
    snapshot: tasks.inspect.output,
  }))
  .task("boundaries", boundariesTask, ({ tasks }) => ({
    snapshot: tasks.inspect.output,
  }))
  .task("aggregate", aggregateFindingsTask, ({ tasks }) => ({
    snapshot: tasks.inspect.output,
    tests: tasks.tests.output,
    dependencies: tasks.dependencies.output,
    documentation: tasks.documentation.output,
    boundaries: tasks.boundaries.output,
  }))
  .repeat("remediation", {
    initial: ({ tasks }) => tasks.aggregate.output,
    body: ({ input, task }) => {
      const applied = task(applySafeRemediationTask, { input });
      return task(verifyReleaseReadinessTask, { input: applied.output }).output;
    },
    until: validatedBy(releaseReadinessValidator),
    maximumIterations: 3,
  })
  .task(
    "report",
    publishReleaseReportTask,
    ({ tasks }) => tasks.remediation.output,
  )
  .output(({ tasks }) => tasks.report.output)
  .define();
