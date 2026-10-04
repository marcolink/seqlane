import { defineAgentTask } from "@seqlane/core";
import { z } from "zod";
import {
  reviewAxisSchema,
  reviewLaneInputSchema,
  reviewLaneResultSchema,
} from "../contracts.js";
import { renderPromptData } from "./review-history.js";
import { reviewProcessInstructions } from "./review-policy.js";
import { CODE_REVIEW_AGENT_TIMEOUT_MS } from "./review-timeout.js";

function createReviewLane(options: {
  readonly id: string;
  readonly axes: readonly z.infer<typeof reviewAxisSchema>[];
  readonly focus: readonly string[];
}) {
  return defineAgentTask({
    id: options.id,
    timeoutMs: CODE_REVIEW_AGENT_TIMEOUT_MS,
    input: reviewLaneInputSchema,
    output: reviewLaneResultSchema,
    goal: ({ review }) =>
      [
        `Review the pull request targeting ${review.baseBranch} using ${review.baseRevision}...${review.headRevision} in ${review.repository} for ${options.axes.join(
          " and ",
        )}.`,
        renderPromptData("Pull-request context and Git evidence", review),
      ].join("\n"),
    instructions: [
      ...reviewProcessInstructions,
      `Rate only these axes from 1 to 5: ${options.axes.join(", ")}.`,
      "Use 5 for no material concern, 4 for minor concerns, 3 for moderate concerns, 2 for required changes, and 1 for critical issues.",
      "Use critical, required, optional, or nit severity for every finding.",
      "Lead with high-leverage critical or required findings; do not bury them under nits.",
      "For a structural concern, recommend a named simplification: a typed model or explicit dispatcher, collapsed duplicate branches, separated orchestration and business logic, feature logic moved to its owner, a canonical helper, an explicit type boundary, a removed pass-through wrapper, or a focused helper or module split.",
      "Return only structured ratings, findings, and inspected verification evidence.",
      ...options.focus,
    ],
  });
}

export const correctnessReviewTask = createReviewLane({
  id: "code-review-correctness",
  axes: ["correctness"],
  focus: [
    "Check that the change matches its stated requirements and expected behaviour, including null, empty, boundary, error, retry, ordering, and state-consistency paths.",
    "Check whether existing tests exercise observable behaviour rather than implementation details, cover relevant edge cases, and would catch a regression.",
    "Inspect recorded verification for test, build, manual, screenshot, and before/after evidence. Distinguish absent evidence from a failed check.",
  ],
});

export const maintainabilityReviewTask = createReviewLane({
  id: "code-review-maintainability",
  axes: ["readability", "architecture"],
  focus: [
    "Check descriptive and consistent names, straightforward control flow, nesting, unnecessary cleverness, comments that explain non-obvious intent, no-op variables, compatibility shims, commented-out code, and dead-code artifacts.",
    "Check conditionals added to unrelated flows and repeated conditionals over the same shape. Treat them as a missing model, dispatcher, helper, state, or policy rather than a formatting nit.",
    "Check existing patterns, cohesive module boundaries, dependency direction, circular coupling, duplicate helpers, appropriate abstraction level, feature logic leaking into shared modules, and explicit type boundaries instead of gratuitous casts, optionals, unknowns, or silent fallbacks.",
    "For refactors, distinguish reduced complexity from complexity merely moved elsewhere. Prefer designs that remove concepts, branches, modes, or layers rather than re-centralising them.",
  ],
});

export const riskReviewTask = createReviewLane({
  id: "code-review-risk",
  axes: ["security", "performance"],
  focus: [
    "Check validated and sanitised input boundaries, secrets in code or logs, authentication and authorization assumptions, injection risks, output encoding, trusted dependencies, and external data treated as untrusted.",
    "Check N+1 work, unbounded loops or fetching, missing pagination, unnecessary data work or re-renders, synchronous work in hot paths, and large objects created on hot paths.",
    "For dependency upgrades, check changelog or migration evidence, isolation by dependency, tests before and after, transitive lockfile changes, and that the lockfile was not hand-edited. Do not inspect lockfile contents; they are excluded from the supplied patch.",
  ],
});

export { reviewLaneResultSchema };
