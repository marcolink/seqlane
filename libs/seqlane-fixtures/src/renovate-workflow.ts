import type { Plan, TaskSchemaRegistry } from "@seqlane/core";
import {
  buildWorkflow,
  createFlow,
  defineAgentTask,
  defineValidator,
} from "@seqlane/core";
import { z } from "zod";

export const RENOVATE_WORKFLOW_ID = "fix-renovate-update";

export const RENOVATE_INVOCATIONS = {
  investigate: {
    taskId: "investigate-renovate-failure",
    nodeId: "investigate-renovate-failure:1",
  },
  plan: {
    taskId: "plan-renovate-fix",
    nodeId: "plan-renovate-fix:1",
  },
  fix: {
    taskId: "apply-renovate-fix",
    nodeId: "apply-renovate-fix:1",
  },
  verify: {
    taskId: "verify-renovate-fix",
    nodeId: "verify-renovate-fix:1",
  },
} as const;

const renovateInputSchema = z.object({
  dependency: z.string(),
  fromVersion: z.string(),
  toVersion: z.string(),
  failure: z.string(),
});

const investigationSchema = z.object({
  files: z.array(z.string()),
  rootCause: z.string(),
});

const planSchema = z.object({
  steps: z.array(z.string()),
  summary: z.string(),
});

const changeSchema = z.object({
  changedFiles: z.array(z.string()),
  summary: z.string(),
});

const verificationSchema = z.object({
  passed: z.boolean(),
  summary: z.string(),
});

const investigateTask = defineAgentTask({
  id: RENOVATE_INVOCATIONS.investigate.taskId,
  input: renovateInputSchema,
  output: investigationSchema,
  goal: ({ dependency, fromVersion, toVersion, failure }) =>
    `Investigate why the ${dependency} update from ${fromVersion} to ${toVersion} failed: ${failure}.`,
  instructions: [
    "Identify the files that need review and state the root cause.",
  ],
  references: ["package.json", "pnpm-lock.yaml"],
});

const planTask = defineAgentTask({
  id: RENOVATE_INVOCATIONS.plan.taskId,
  input: z.object({ investigation: investigationSchema }),
  output: planSchema,
  goal: ({ investigation }) =>
    `Create a remediation plan for this Renovate root cause: ${investigation.rootCause}.`,
  instructions: ["Return ordered steps that can be applied and verified."],
});

const fixTask = defineAgentTask({
  id: RENOVATE_INVOCATIONS.fix.taskId,
  input: z.object({ plan: planSchema }),
  output: changeSchema,
  goal: ({ plan }) => `Apply the Renovate remediation plan: ${plan.summary}.`,
  instructions: ["List every changed file and summarize the applied fix."],
});

const verifyTask = defineAgentTask({
  id: RENOVATE_INVOCATIONS.verify.taskId,
  input: z.object({ change: changeSchema }),
  output: verificationSchema,
  goal: ({ change }) =>
    `Verify the Renovate fix described as: ${change.summary}.`,
  instructions: ["Report whether the relevant install and tests pass."],
});

const verificationValidator = defineValidator({
  id: "verify-renovate-fix.semantic",
  input: verificationSchema,
  validate: ({ passed }) =>
    passed
      ? { success: true }
      : {
          success: false,
          issues: [
            {
              code: "verification-failed",
              message: "The Renovate fix did not pass verification",
            },
          ],
        },
});

export const renovateWorkflow = createFlow({
  id: RENOVATE_WORKFLOW_ID,
  input: renovateInputSchema,
  output: z.object({
    change: changeSchema,
    verification: verificationSchema,
  }),
})
  .task("investigation", investigateTask, ({ input }) => ({
    dependency: input.dependency,
    fromVersion: input.fromVersion,
    toVersion: input.toVersion,
    failure: input.failure,
  }))
  .task("plan", planTask, ({ tasks }) => ({
    investigation: tasks.investigation.output,
  }))
  .task("change", fixTask, ({ tasks }) => ({ plan: tasks.plan.output }))
  .task("verification", verifyTask, ({ tasks }) => ({
    change: tasks.change.output,
  }))
  .validate(
    "verificationGate",
    verificationValidator,
    ({ tasks }) => tasks.verification.output,
  )
  .output(({ tasks }) => ({
    change: tasks.change.output,
    verification: tasks.verification.output,
  }))
  .define();

const builtRenovateWorkflow = buildWorkflow(renovateWorkflow);

export const renovateTaskSchemas: TaskSchemaRegistry =
  builtRenovateWorkflow.taskDefinitions;
export const renovateTaskDefinitions = builtRenovateWorkflow.taskDefinitions;
export const renovateValidatorDefinitions =
  builtRenovateWorkflow.validatorDefinitions;

export function createRenovatePlan(): Plan {
  return builtRenovateWorkflow.plan;
}
