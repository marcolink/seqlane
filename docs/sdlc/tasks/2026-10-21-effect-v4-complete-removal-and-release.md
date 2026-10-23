---
id: task.effect-v4-complete-removal-and-release
title: Complete removal and release gate
status: completed
owners:
  - core
created: 2026-10-21
updated: 2026-10-22
upstream:
  - spec.effect-v4-execution-and-operations
  - task.effect-v4-remaining-actions-and-distribution
supersedes: []
---

# Complete removal and release gate

## Objective

Transfer retained requirements into target-only documents and replace legacy IDs in all relationships.

## Upstream requirements

The target contract is owned by [spec.effect-v4-execution-and-operations](../specs/2026-10-21-effect-v4-execution-and-operations.md). The coordination task links the full migration checklist and cross-slice gates. This task implements its bounded slice and does not redefine product requirements or the target contract.

## Scope

Implement this slice's behavior and removal boundary under the active target specification.

## Out of scope

Changes to product behavior, public authoring contracts, or wire contracts beyond the target specification's explicit requirements.

## Implementation plan

- Transfer retained requirements into target-only documents and replace legacy IDs in all relationships.
- Remove obsolete engine documents and tracked skills after content transfer.
- Rewrite this plan and the proposal into target-only records, or remove them after retained contracts have canonical owners.
- Update every README, example, AGENTS instruction, CI rule, manifest, Nx target, release script, and generated asset.
- Audit tracked contents and filenames case-insensitively, with no documentation or test exceptions.
- Construct the audit pattern without retaining the old name as a literal in the final guard.
- Regenerate the lockfile, rebuild from clean outputs, and inspect declarations, sourcemaps, Action bundles, and packed npm packages.
- An empty source search alone does not prove that dependencies or bundles are clean.
- Record code/dependency/bundle deltas and reachable delivery commits or merged PR evidence.
- Do not mark complete while required remote CI is pending.

## Documentation impact

Classification: architecture change within the accepted migration.

- PRD: retain engine-neutral product requirements.
- RFC and SPEC: transfer retained contracts before removing retired records; record final package dispositions.
- TASK: this task owns final removal, clean outputs, dependency closure, distribution, and exact-head hosted CI.
- Nearby docs and skills: remove retired instructions and document current Effect ownership.
- ADR required: no new decision; the accepted RFC explicitly requires complete tracked-tree removal.

### Bounded delivery plan

1. Transfer retained canonical requirements and inbound relationships to target-only owners. Remove obsolete records without claiming historical Effect delivery.
2. Remove unused engine compilation and integration code after checking all consumers. Keep pure helpers only where the current program uses them.
3. Remove remaining direct dependencies, regenerate the lockfile, and audit all 23 packages and root tooling.
4. Add a zero-evidence guard for tracked names/content, rebuilt distributions, release archives, and production dependency closure. Construct its search token without a retained literal.
5. Clean owned build outputs, rebuild, run full gates, and verify installed packages, Action bundles, compiled CLI, release dry runs, security/license evidence, and measured deltas.
6. Commit S12 once, push the approved feature branch, and require CI on its exact final head. Reconcile final evidence by amending the same task commit.

### Ownership and sequencing

Fresh implementation sessions own canonical document transfer, retired source removal, and nearby/public documentation and skills. Root owns manifests, lockfile, removal tooling, baseline artifact, metrics, all acceptance gates, delivery reconciliation, and Git. No other task starts during S12. Freeze all writers before clean builds and full verification.

## Affected areas

The implementation files identified from the current source during this slice.

## Verification

complete verification matrix, all 23 package dispositions, no old runtime or dependency closure, and reviewed behavior-change documentation.

## Completion criteria

- The scoped behavior is implemented and the verification evidence above passes.
- The replaced path is removed: remove the old engine-specific path after its callers migrate.
- Record any unavailable live evidence and remaining delivery limits.

## Outcome

All S12 implementation and final local gates pass after accepted S11 commit `0fa0fc44c988a1ce7f0d56a41e1a53389015b63f`. [Hosted CI](https://github.com/marcolink/seqlane/actions/runs/39751001939) passes quality and actual Action entry/post gates for implementation checkpoint `4ae36416120bbe3e81405b06903b1f7a93681c21`. Publishing is skipped. The final task commit reconciles only documentation, measurements, and completion metadata after that checkpoint.

- Retained workflow and adapter-observation requirements have explicit target-only owners. Obsolete integration records, private source, fixtures, skills, dependency pins, exemptions, and CI credentials are removed.
- Public authoring and wire schemas remain Zod-owned. Oclif still owns CLI parsing and conventions. Canonical events, complete observations, optional telemetry, and durable hosted inspection remain supported.
- Migrated choice regressions exposed strict Boolean validation, unstarted branch terminals, and isolated session acquisition gaps. The fixes preserve malformed-input rejection, failure/cancellation terminals, and late-acquisition cleanup.
- Repeated compiled measurements exposed two short-process ownership handoff races. Real-child regressions prove both failures before the fix. Registration now accepts an exited process only after native group absence is confirmed. Unknown identity, active foreign groups, disconnects, and uncertain cleanup still fail safely.
- The final clean full repository gate passes after the handoff repair: frozen install, 350-document validation, 601 test mappings, typechecks, all tests, lint, all 23 builds, formatting, Nx synchronization, and diff checks. Compiled CLI checks pass: 116 tests pass and one duplicate Codex trace case is skipped. All eight installed tarballs, Action main/post fixtures, and complete distribution audits pass against the rebuilt outputs. The audit covers 1,281 source files, 1,365 generated files, eight archives, and 199 production dependency nodes, with zero retired evidence.
- Positive-version archive validation and actual publish dry runs pass for all eight packages at `0.3.0` in an isolated snapshot. Repository versions, tags, remote Git state, and registry data remain unchanged.

The [measurement artifact](./2026-10-21-effect-v4-inventory.json) records matched baseline and target workloads, code/dependency/bundle deltas, security/license findings, and verification details. Startup, graph execution, ready-node latency, and peak RSS improve in local samples. Confirmed shutdown increases from about 31 ms to 133 ms; native identity, acknowledgement, group verification, and finite polling add explicit cleanup cost. Event encoding preserves identical bytes; single timing samples are diagnostic rather than a regression threshold. Code counts include tests and grow while dependencies and bundled JavaScript shrink.

Production dependency auditing reports zero known vulnerabilities after compatible transitive patch updates. The full workspace audit retains 77 pre-existing development-tool advisories and introduces no new advisory IDs. Those tooling findings are recorded, not treated as resolved by runtime migration.

Reviewed structural diagnostics retain atomic methods that static reachability misses, small command wrappers with different verification bounds, private ownership guards, and migration churn. No quality baseline or blanket acknowledgement hides findings. Native Windows live execution, uncached Docker image execution, and the unavailable OpenCode provider remain explicit limits of prior slices.

## Delivery state

Completed on `feat/effect-v4-migration` in this S12 task commit. The reachable task commit and successful CI on its exact published head establish delivery. [Branch CI history](https://github.com/marcolink/seqlane/actions/workflows/ci.yml?query=branch%3Afeat%2Feffect-v4-migration) records those heads. The earlier implementation-checkpoint run is source verification before documentation-only reconciliation, not the final reachability identity. Default-branch merge and registry publication are outside this delivery.

## Traceability

- [spec.effect-v4-execution-and-operations: target contract](../specs/2026-10-21-effect-v4-execution-and-operations.md)
- [task.effect-v4-remaining-actions-and-distribution: prerequisite task](./2026-10-21-effect-v4-remaining-actions-and-distribution.md)
- [task.migrate-all-packages-to-effect-v4: coordination checklist](./2026-10-21-migrate-all-packages-to-effect-v4.md)
