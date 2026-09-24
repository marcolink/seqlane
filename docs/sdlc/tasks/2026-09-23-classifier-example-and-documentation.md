---
id: task.classifier-example-and-documentation
title: Demonstrate Classifier Tasks in Git Diff Summary
status: in-progress
owners:
  - core
created: 2026-09-23
updated: 2026-09-24
upstream:
  - spec.classifier-tasks
  - task.classifier-reliability-and-observation
supersedes: []
---

# Demonstrate Classifier Tasks in Git Diff Summary

## Objective

Add a readable classifier stage to an existing portable workflow and document
the author/operator experience. The example proves a complete user path after
the core and runtime contracts are stable.

## Upstream requirements

Finish [spec.classifier-tasks, acceptance criteria](../specs/2026-09-23-classifier-tasks.md#acceptance-criteria) after [task.classifier-reliability-and-observation](./2026-09-23-classifier-reliability-and-observation.md).

## Scope

- Add a classifier after bounded Git evidence in
  `workflows/git-diff-summary-example/workflow.ts`. It asks one Choice about
  review area, one Score about review urgency, and one Noul about security
  review. Give each criterion a concrete, readable description.
- Declare all questions, instructions, Choice options, and Score levels in the
  classifier task. Its `state` callback selects the bounded diff from parsed
  input.
- Return the complete classifier result alongside the two existing summary
  lanes. Do not use its probabilities to skip a lane or publish a review.
- Complete the public classifier authoring page with runnable Choice, Score,
  and Noul definitions; input-derived state; and a representative JSON result
  showing model, answers, distributions, confidence, Score legend, Noul
  probability, usage, and preserved extensions. Explain that probabilities are
  results, while a downstream task owns any application decision.
- Document the 20-second transport budget, up to three retries after the first
  attempt, retryable failures, `Retry-After`, and cancellation. State that the
  budget starts after synchronous state selection, validation, and
  serialization.
- Update the public CLI page and nearby README/AGENTS material with both
  classifier-only and mixed agent/classifier commands. Show paired URL/model
  flags, the API key environment variable, adapter use for agent tasks, and
  the absence of a token CLI flag.
- Replace the homepage Introduction feature card in `apps/docs/index.md` with
  a Classifier tasks card linking to the public authoring page. The hero and
  navigation already link to the introduction.

## Out of scope

- Replacing the production `workflows/code-review` risk lane, changing review
  publication, adding a Jevais-style threshold helper, or claiming Laya support.

## Implementation plan

### Tracer bullet

- **Outcome:** one Git diff example run returns its existing summaries plus
  complete Choice, Score, and Noul answers.
- **Path:** CLI input → Git diff shell task → bounded evidence → classifier
  `state` → private Jev-compatible HTTP fixture → workflow output/CI JSON.
- **Risk:** the example may require large unbounded diffs or disturb existing
  summary contracts.
- **Evidence:** a focused example integration test confirms bounded evidence,
  static questions, input-derived state, existing summaries, and full
  classifier output. One manual Jev run can be recorded separately if a key is
  supplied; fixture evidence is the required gate.
- **Excluded:** production code-review routing and threshold policy.

1. Add a cohesive classifier task file and extend the example input/output
   schemas. Keep all existing summaries and their schemas readable.
2. Add the focused integration test through the existing workflow loader and
   Mastra runtime. Follow the repository test-to-implementation mapping rule.
3. Update `workflows/git-diff-summary-example/README.md`, the public classifier
   authoring page, CLI run page, and nearby README/AGENTS material. Show the
   complete output and both run modes. Replace the homepage Introduction card
   with a Classifier tasks card.
4. Run full feature verification and docs checks. Record exact commands and
   distinguish fixture proof from any live API proof.

## Affected areas

`workflows/git-diff-summary-example/`, `apps/docs/index.md`,
`apps/docs/authoring-workflows/classifier-tasks.md`,
`apps/docs/authoring-workflows/models.md`, `apps/docs/cli/run.md`,
`apps/docs/introduction/`, `apps/docs/adapters/overview.md`, nearby READMEs,
CLI help text, and focused integration tests. The production code-review graph
stays unchanged in this task.

## Verification

- Run test mapping, example integration tests, CLI flag tests, core/runtime
  focused suites, typecheck, lint, build, and public API boundary checks.
- Run `pnpm docs:index`, `pnpm docs:validate`, public docs build, public docs
  formatting, and `git diff --check`. Check the homepage card link and both
  documented command forms against the CLI parser. Point the mixed command to
  the runnable Git diff example when its classifier stage lands.
- Verify neither the docs nor the example puts a token in a workflow source,
  Plan, CLI argument, trace, or checked-in fixture.
- If a live Jev smoke test is available, record endpoint model/version,
  request kind, returned shape, and outcome without recording the token.

## Completion criteria

- The example is runnable and shows static Choice, Score, and Noul questions
  with the full probabilistic result, without altering the agent summaries'
  meaning.
- An author can copy the documented three-kind task pattern and interpret the
  complete result. An operator can configure a classifier-only or mixed run
  from the CLI documentation.
- The public homepage advertises classifier tasks through a working card link.
- The full spec's acceptance criteria and documentation checks pass.

## Outcome

Public classifier documentation now covers all three question kinds, the full
result, run configuration, and retry behavior. The public homepage has a
Classifier tasks card, and nearby model and introduction pages distinguish
classifier calls from agent adapters. This work is local. The Git diff summary
example and its integration test remain pending.

## Delivery state

Public docs implemented locally. The complete task has no target-branch
delivery claim.

## Traceability

- [spec.classifier-tasks](../specs/2026-09-23-classifier-tasks.md)
- [task.classifier-reliability-and-observation](./2026-09-23-classifier-reliability-and-observation.md)
- [Git diff summary example](../../../workflows/git-diff-summary-example/README.md)
