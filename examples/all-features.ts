import {
  branch,
  createFlow,
  defineTask,
  defineValidator,
  isolated,
  reuse,
} from "@seqlane/core";
import { z } from "zod";

const inputSchema = z.object({
  topic: z.string().min(1),
  focus: z.string().min(1),
});

const contextSchema = z.object({
  topic: z.string(),
  focus: z.string(),
  keywords: z.array(z.string()).min(1),
  hint: z.string(),
});

const laneSchema = z.object({
  label: z.string(),
  note: z.string().min(1),
});

const policySchema = z.object({
  version: z.literal("v1"),
  rule: z.string().min(1),
});

const joinedSchema = z.object({
  context: contextSchema,
  left: laneSchema,
  right: laneSchema,
  summary: z.string().min(1),
});

const polishStateSchema = z.object({
  summary: z.string().min(1),
  ready: z.boolean(),
  passes: z.number().int().nonnegative(),
});

const validationIssueSchema = z.object({
  code: z.string(),
  message: z.string(),
  path: z.string().optional(),
});

const validationResultSchema = z.discriminatedUnion("success", [
  z.object({ success: z.literal(true), evidence: z.json().optional() }),
  z.object({
    success: z.literal(false),
    issues: z.tuple([validationIssueSchema]).rest(validationIssueSchema),
    evidence: z.json().optional(),
  }),
]);

const outputSchema = z.object({
  context: contextSchema,
  policy: policySchema,
  validation: validationResultSchema,
  polished: polishStateSchema,
});

const contextValidator = defineValidator({
  id: "all-features.context-ready",
  input: contextSchema,
  validate: ({ keywords }) =>
    keywords.length > 0
      ? { success: true, evidence: { keywordCount: keywords.length } }
      : {
          success: false,
          issues: [
            {
              code: "missing-keywords",
              message: "The context must contain at least one keyword",
            },
          ],
        },
});

const joinedValidator = defineValidator({
  id: "all-features.joined-ready",
  input: joinedSchema,
  validate: ({ left, right, summary }) =>
    left.note.trim().length > 0 &&
    right.note.trim().length > 0 &&
    summary.trim().length > 0
      ? { success: true, evidence: { lanes: 2 } }
      : {
          success: false,
          issues: [
            {
              code: "incomplete-summary",
              message: "Both lanes and the summary must contain text",
            },
          ],
        },
});

const polishValidator = defineValidator({
  id: "all-features.polished",
  input: polishStateSchema,
  validate: ({ summary, passes }) =>
    summary.trim().length > 0 && passes > 0
      ? { success: true, evidence: { passes } }
      : {
          success: false,
          issues: [
            {
              code: "not-polished",
              message: "The summary must be non-empty and have one pass",
            },
          ],
        },
});

const contextTask = defineTask({
  id: "all-features.context",
  workspace: "shared",
  input: inputSchema,
  output: contextSchema,
  goal: ({ topic, focus }) =>
    `Extract two keywords and a short focus hint for ${topic} (${focus}).`,
  instructions: ["Return only two keywords and a short focus hint."],
  references: ["examples/minimal-workflow.ts"],
  observability: {
    studio: {
      input: { includePaths: ["/topic", "/focus"] },
      result: { includePaths: ["/keywords", "/hint"] },
      activity: {
        input: { includePaths: ["/topic"] },
        output: { includePaths: ["/keywords"] },
        metadata: { includePaths: ["/tool"] },
      },
    },
  },
});

const laneTask = defineTask({
  id: "all-features.lane",
  workspace: "shared",
  input: contextSchema,
  output: laneSchema,
  goal: ({ hint, keywords }) =>
    `Write one short ${hint} note using ${keywords.join(", ")}.`,
  instructions: ["Return one label and one concise note."],
});

const policyTask = defineTask({
  id: "all-features.policy",
  workspace: "shared",
  input: z.object({ version: z.literal("v1") }),
  output: policySchema,
  goal: () => "Return the static v1 policy used by this example.",
  instructions: ["Return the policy version and one short rule."],
});

const joinedTask = defineTask({
  id: "all-features.joined",
  workspace: "exclusive",
  input: z.object({
    context: contextSchema,
    left: laneSchema,
    right: laneSchema,
  }),
  output: joinedSchema,
  goal: ({ context, left, right }) =>
    `Join the ${context.topic} context and two notes: ${left.note}; ${right.note}.`,
  instructions: [
    "Return the source context, both lanes, and one short summary.",
  ],
});

const polishTask = defineTask({
  id: "all-features.polish",
  workspace: "shared",
  input: polishStateSchema,
  output: polishStateSchema,
  goal: ({ summary, passes }) =>
    `Polish this summary in one pass (${passes}): ${summary}`,
  instructions: [
    "Return the same summary in concise form, ready true, and passes increased by one.",
  ],
});

export default createFlow({
  id: "all-features",
  input: inputSchema,
  output: outputSchema,
})
  .task("context", contextTask, ({ input }) => input, {
    session: isolated(),
    validateOutput: contextValidator,
  })
  .task("left", laneTask, ({ tasks }) => tasks.context.output, {
    session: ({ tasks }) => branch(tasks.context.session),
  })
  .task(
    "right",
    laneTask,
    ({ input, tasks }) => ({
      topic: input.topic,
      focus: input.focus,
      keywords: tasks.context.output.keywords,
      hint: "right-lane",
    }),
    { session: ({ tasks }) => branch(tasks.context.session) },
  )
  .task("policy", policyTask, { version: "v1" })
  .task(
    "joined",
    joinedTask,
    ({ tasks }) => ({
      context: tasks.context.output,
      left: tasks.left.output,
      right: tasks.right.output,
    }),
    {
      dependsOn: ["policy"],
      session: ({ tasks }) => reuse(tasks.left.session),
    },
  )
  .validate("ready", joinedValidator, ({ tasks }) => tasks.joined.output)
  .task(
    "polish",
    polishTask,
    ({ tasks }) => ({
      summary: tasks.ready.output.summary,
      ready: false,
      passes: 0,
    }),
    {
      validateOutput: polishValidator,
    },
  )
  .output(({ tasks }) => ({
    context: tasks.context.output,
    policy: tasks.policy.output,
    validation: tasks.ready.validation,
    polished: tasks.polish.output,
  }))
  .define();
