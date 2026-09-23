---
id: task.classifier-example-and-documentation
title: Demonstrate Classifier Tasks in Git Diff Summary
status: planned
owners:
  - core
created: 2026-09-23
updated: 2026-09-23
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
- Extend the Noul tracer documentation with the JSON result fields, static
  question definitions, dynamic state selection, 20-second transport budget,
  three retries, and the difference between a probability and an application
  decision.
- Update nearby README/AGENTS material and the dedicated public classifier
  authoring and CLI pages for Choice, Score, and mixed agent/classifier runs.

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
3. Update `workflows/git-diff-summary-example/README.md`, public authoring
   pages, CLI run page, and package README material affected by new flags.
4. Run full feature verification and docs checks. Record exact commands and
   distinguish fixture proof from any live API proof.

## Affected areas

`workflows/git-diff-summary-example/`, `apps/docs/authoring-workflows/`,
`apps/docs/cli/run.md`, nearby READMEs, CLI help text, and focused integration
tests. The production code-review graph stays unchanged in this task.

## Verification

- Run test mapping, example integration tests, CLI flag tests, core/runtime
  focused suites, typecheck, lint, build, and public API boundary checks.
- Run `pnpm docs:index`, `pnpm docs:validate`, public docs build, and
  `git diff --check`.
- Verify neither the docs nor the example puts a token in a workflow source,
  Plan, CLI argument, trace, or checked-in fixture.
- If a live Jev smoke test is available, record endpoint model/version,
  request kind, returned shape, and outcome without recording the token.

## Completion criteria

- The example is runnable and shows static Choice, Score, and Noul questions
  with the full probabilistic result, without altering the agent summaries'
  meaning.
- An author can copy the documented task pattern; an operator can configure
  the endpoint and token from the CLI documentation.
- The full spec's acceptance criteria and documentation checks pass.

## Outcome

Pending implementation.

## Delivery state

Planned. No implementation or target-branch delivery is claimed.

## Traceability

- [spec.classifier-tasks](../specs/2026-09-23-classifier-tasks.md)
- [task.classifier-reliability-and-observation](./2026-09-23-classifier-reliability-and-observation.md)
- [Git diff summary example](../../../workflows/git-diff-summary-example/README.md)
