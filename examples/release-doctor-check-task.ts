import { defineTask, type TaskDefinition } from "@seqlane/core";
import { z } from "zod";

export const releaseDoctorRepositorySnapshotSchema = z.object({
  repository: z.string(),
  baseBranch: z.string(),
  packageManager: z.string(),
  changedFiles: z.array(z.string()),
});

export const releaseDoctorFindingSchema = z.object({
  check: z.string(),
  status: z.enum(["pass", "warning", "fail"]),
  summary: z.string(),
  recommendation: z.string(),
});

const releaseDoctorCheckInputSchema = z.object({
  snapshot: releaseDoctorRepositorySnapshotSchema,
});

const releaseDoctorCheckInstructions = [
  "Inspect the repository without modifying files.",
  "Return one structured finding with pass, warning, or fail status.",
  "Include a concrete recommendation when status is warning or fail.",
];

type ReleaseDoctorCheckInput = z.infer<typeof releaseDoctorCheckInputSchema>;
type ReleaseDoctorFinding = z.infer<typeof releaseDoctorFindingSchema>;

export function createReleaseDoctorCheckTask(options: {
  readonly id: string;
  readonly goal: (input: ReleaseDoctorCheckInput) => string;
}): TaskDefinition<ReleaseDoctorCheckInput, ReleaseDoctorFinding> {
  return defineTask({
    id: options.id,
    workspace: "shared",
    input: releaseDoctorCheckInputSchema,
    output: releaseDoctorFindingSchema,
    goal: options.goal,
    instructions: releaseDoctorCheckInstructions,
    observability: {
      studio: { result: { includePaths: ["/status", "/summary"] } },
    },
  });
}
