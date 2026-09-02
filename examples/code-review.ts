import {
  branch,
  createFlow,
  defineTask,
  reuse,
} from "@seqlane/core";
import { z } from "zod";

// Review rubric: https://github.com/addyosmani/agent-skills/blob/main/skills/code-review-and-quality/SKILL.md
const reviewTargetSchema = z.enum(["last-commit", "uncommitted"]);
const reviewAxisSchema = z.enum([
  "correctness",
  "readability",
  "architecture",
  "security",
  "performance",
]);
const reviewSeveritySchema = z.enum([
  "critical",
  "required",
  "optional",
  "nit",
]);

const codeReviewInputSchema = z.object({
  repository: z.string().min(1),
  target: reviewTargetSchema,
});

const codeReviewChangeSchema = z.object({
  repository: z.string(),
  target: reviewTargetSchema,
  revision: z.string(),
  changedFiles: z.array(z.string()),
  summary: z.string(),
});

const reviewRatingSchema = z.object({
  axis: reviewAxisSchema,
  rating: z.number().int().min(1).max(5),
  rationale: z.string().min(1),
});

const reviewFindingSchema = z.object({
  axis: reviewAxisSchema,
  severity: reviewSeveritySchema,
  summary: z.string().min(1),
  recommendation: z.string().min(1),
  file: z.string().min(1).optional(),
  line: z.number().int().positive().optional(),
});

const reviewLaneInputSchema = z.object({
  change: codeReviewChangeSchema,
});

const reviewLaneResultSchema = z.object({
  ratings: z.array(reviewRatingSchema).min(1).max(2),
  findings: z.array(reviewFindingSchema),
  verification: z.array(z.string()),
});

const codeReviewReportSchema = z.object({
  repository: z.string(),
  target: reviewTargetSchema,
  revision: z.string(),
  overallRating: z.number().int().min(1).max(5),
  verdict: z.enum(["approve", "request-changes"]),
  summary: z.string().min(1),
  ratings: z.array(reviewRatingSchema).length(5),
  findings: z.array(reviewFindingSchema),
  verification: z.array(z.string()),
});

const reviewProcessInstructions = [
  "Review in this order: understand the requested change and expected behaviour; inspect changed tests and verification evidence first; then inspect the implementation and relevant surrounding code.",
  "Use concrete evidence from the change. Do not rubber-stamp, infer passing checks, or claim manual verification that is not recorded.",
  "Assess change size: roughly 100 changed lines is easy to review, roughly 300 is acceptable when focused, and roughly 1000 should usually be split. Also flag a file that grows toward roughly 1000 total lines without decomposition.",
  "If dependencies changed, inspect package metadata, the lockfile, and changelog or migration evidence when present. Flag bulk upgrades, missing lockfile changes, or missing verification evidence.",
  "Surface unreachable or now-unused code explicitly. Do not recommend silently deleting it; identify it and state why its removal needs explicit author approval.",
];

const nonInteractiveInstructions = [
  "Work non-interactively. Do not ask questions, solicit choices, use an ask or question tool, or wait for a response.",
  "When evidence is sufficient, return the final response immediately; the runtime validates it against the supplied output schema.",
  "When evidence is unavailable or an instruction is ambiguous, apply the conservative default and record the limitation in the final response.",
];

const inspectChangeTask = defineTask({
  id: "code-review.inspect",
  workspace: "shared",
  input: codeReviewInputSchema,
  output: codeReviewChangeSchema,
  goal: ({ repository, target }) =>
    `Inspect the ${target} change in ${repository} for a code review.`,
  instructions: [
    ...nonInteractiveInstructions,
    "Use only the approved read-only Git commands: git rev-parse HEAD, git diff --no-ext-diff --no-textconv HEAD^ HEAD, git diff --no-ext-diff --no-textconv --root HEAD, git status --short, git diff --no-ext-diff --no-textconv, git diff --no-ext-diff --no-textconv --cached, and git ls-files --others --exclude-standard.",
    "For last-commit, inspect HEAD and its diff. For uncommitted, inspect staged, unstaged, and untracked files.",
  ],
  observability: {
    studio: {
      result: {
        includePaths: ["/target", "/revision", "/changedFiles", "/summary"],
      },
    },
  },
});

function createReviewLane(options: {
  readonly id: string;
  readonly axes: readonly z.infer<typeof reviewAxisSchema>[];
  readonly focus: readonly string[];
}) {
  return defineTask({
    id: options.id,
    workspace: "shared",
    input: reviewLaneInputSchema,
    output: reviewLaneResultSchema,
    goal: ({ change }) =>
      `Review ${change.revision} in ${change.repository} for ${options.axes.join(
        " and ",
      )}.`,
    instructions: [
      ...nonInteractiveInstructions,
      ...reviewProcessInstructions,
      `Rate only these axes from 1 to 5: ${options.axes.join(", ")}.`,
      "Use 5 for no material concern, 4 for minor concerns, 3 for moderate concerns, 2 for required changes, and 1 for critical issues.",
      "Use critical, required, optional, or nit severity for every finding.",
      "Lead with high-leverage critical or required findings; do not bury them under nits.",
      "For a structural concern, recommend a named simplification: a typed model or explicit dispatcher, collapsed duplicate branches, separated orchestration and business logic, feature logic moved to its owner, a canonical helper, an explicit type boundary, a removed pass-through wrapper, or a focused helper or module split.",
      "Return only structured ratings, findings, and inspected verification evidence.",
      ...options.focus,
    ],
    observability: {
      studio: {
        result: { includePaths: ["/ratings", "/findings", "/verification"] },
      },
    },
  });
}

const correctnessReviewTask = createReviewLane({
  id: "code-review.correctness",
  axes: ["correctness"],
  focus: [
    "Check that the change matches its stated requirements and expected behaviour, including null, empty, boundary, error, retry, ordering, and state-consistency paths.",
    "Check whether existing tests exercise observable behaviour rather than implementation details, cover relevant edge cases, and would catch a regression.",
    "Inspect recorded verification for test, build, manual, screenshot, and before/after evidence. Distinguish absent evidence from a failed check.",
  ],
});

const maintainabilityReviewTask = createReviewLane({
  id: "code-review.maintainability",
  axes: ["readability", "architecture"],
  focus: [
    "Check descriptive and consistent names, straightforward control flow, nesting, unnecessary cleverness, comments that explain non-obvious intent, no-op variables, compatibility shims, commented-out code, and dead-code artifacts.",
    "Check conditionals added to unrelated flows and repeated conditionals over the same shape. Treat them as a missing model, dispatcher, helper, state, or policy rather than a formatting nit.",
    "Check existing patterns, cohesive module boundaries, dependency direction, circular coupling, duplicate helpers, appropriate abstraction level, feature logic leaking into shared modules, and explicit type boundaries instead of gratuitous casts, optionals, unknowns, or silent fallbacks.",
    "For refactors, distinguish reduced complexity from complexity merely moved elsewhere. Prefer designs that remove concepts, branches, modes, or layers rather than re-centralising them.",
  ],
});

const riskReviewTask = createReviewLane({
  id: "code-review.risk",
  axes: ["security", "performance"],
  focus: [
    "Check validated and sanitised input boundaries, secrets in code or logs, authentication and authorization assumptions, injection risks, output encoding, trusted dependencies, and external data treated as untrusted.",
    "Check N+1 work, unbounded loops or fetching, missing pagination, unnecessary data work or re-renders, synchronous work in hot paths, and large objects created on hot paths.",
    "For dependency upgrades, check changelog or migration evidence, isolation by dependency, tests before and after, transitive lockfile changes, and that the lockfile was not hand-edited.",
  ],
});

const synthesizeReviewInputSchema = z.object({
  change: codeReviewChangeSchema,
  correctness: reviewLaneResultSchema,
  maintainability: reviewLaneResultSchema,
  risk: reviewLaneResultSchema,
});

const synthesizeReviewTask = defineTask({
  id: "code-review.summarize",
  workspace: "shared",
  input: synthesizeReviewInputSchema,
  output: codeReviewReportSchema,
  goal: ({ change }) =>
    `Synthesize a five-axis review rating for ${change.revision} in ${change.repository}.`,
  instructions: [
    ...nonInteractiveInstructions,
    "Use only evidence supplied by the review lanes; do not infer evidence.",
    "Return exactly one rating for each of correctness, readability, architecture, security, and performance.",
    "Order findings by severity and leverage: critical and required first, then structural regressions, then optional findings and nits.",
    "Use critical for a merge blocker such as a security vulnerability, data loss, or broken behaviour; required for a must-fix concern; optional for a worthwhile non-blocking improvement; and nit for a minor preference.",
    "For every structural finding, retain a concrete remedy rather than only describing complexity. Preserve verification evidence and explicitly name missing test, build, manual, screenshot, or before/after evidence.",
    "Do not accept deferred cleanup as a resolution for a required finding. Keep code-health concerns evidence-based and do not manufacture a finding merely to be adversarial.",
    "Set verdict to request-changes when any critical or required finding remains; otherwise set it to approve.",
    "Return only the complete structured review report.",
  ],
  observability: {
    studio: {
      result: {
        includePaths: ["/overallRating", "/verdict", "/summary", "/findings"],
      },
    },
  },
});

export default createFlow({
  id: "repository-code-review",
  input: codeReviewInputSchema,
  output: codeReviewReportSchema,
})
  .task("inspect", inspectChangeTask, ({ input }) => input)
  .task(
    "correctness",
    correctnessReviewTask,
    ({ tasks }) => ({ change: tasks.inspect.output }),
    { session: ({ tasks }) => branch(tasks.inspect.session) },
  )
  .task(
    "maintainability",
    maintainabilityReviewTask,
    ({ tasks }) => ({ change: tasks.inspect.output }),
    { session: ({ tasks }) => branch(tasks.inspect.session) },
  )
  .task(
    "risk",
    riskReviewTask,
    ({ tasks }) => ({ change: tasks.inspect.output }),
    { session: ({ tasks }) => branch(tasks.inspect.session) },
  )
  .task(
    "summarize",
    synthesizeReviewTask,
    ({ tasks }) => ({
      change: tasks.inspect.output,
      correctness: tasks.correctness.output,
      maintainability: tasks.maintainability.output,
      risk: tasks.risk.output,
    }),
    {
      session: ({ tasks }) => reuse(tasks.inspect.session),
    },
  )
  .output(({ tasks }) => tasks.summarize.output)
  .define();
