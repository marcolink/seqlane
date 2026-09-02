# TS-015-06 — Add Validation Fixtures and Workflow Coverage

**Status:** completed

## User outcome

As a Seqlane maintainer, I can verify semantic validation through representative
workflows without live models, repositories, or external services.

## Scope

- Add mechanical, evaluator, task-output, and repeat-postcondition fixtures.
- Expose only intentional fixture subpaths.
- Extend runtime profile fakes for evaluator coverage.
- Add end-to-end workflow and boundary coverage.
- Update mutable README and architecture indexes.

## Out of scope

- Changes to existing production built-in workflow behavior unless needed for
  representative validation coverage.
- Live executor or model tests.

## Implementation notes

- Use deterministic validators and fake evaluator executors.
- Verify Plans contain no callbacks or executor objects.
- Keep CLI behavior unchanged except for protocol/type coverage.

## Acceptance criteria

**Scenario:** *A fixture uses task-level validation*

- **Given:** A fixture task has `validateOutput`
- **When:** The fixture workflow runs
- **Then:** Passing output continues and failing output blocks its dependent

**Scenario:** *A fixture uses an evaluator postcondition*

- **Given:** A repeat uses `until: validatedBy(evaluatorTask)`
- **When:** The fake evaluator fails and then passes
- **Then:** The repeat performs the expected bounded iterations

**Scenario:** *Fixture exports stay intentional*

- **Given:** The fixture package is consumed across a package boundary
- **When:** A validation fixture is imported
- **Then:** It is available only through a declared package export

## Source

- [ADR-015](../../ADR-015-semantic-validation-gates.md)
- [TS-015](../../TS-015-semantic-validation-gates.md)
- [TS-008](../../TS-008-executor-neutral-workflow-authoring.md)
