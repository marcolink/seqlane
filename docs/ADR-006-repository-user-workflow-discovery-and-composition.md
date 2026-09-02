# ADR-006 — Support Repository and User Scoped Composition Using Ordinary TypeScript

**Status:** Proposed  
**Scope:** Workflow organization, discovery, and composition  
**Related:** PRD, RFC 1, Seqlane MVP

## Context

Seqlane needs to support opinionated automation at two important scopes:

- repositories should encode engineering practices specific to that codebase;
- individual engineers should be able to reuse personal workflows and tasks across repositories.

Workflow authors must also be able to compose existing capabilities and create new local tasks without registration ceremony.

Seqlane should provide discoverability without inventing a proprietary package/module system that competes with TypeScript and npm.

## Decision

Seqlane will support first-class **repository** and **user** capability scopes.

Conceptually:

```text
Repository scope
  tasks
  workflows

User scope
  tasks
  workflows

Local workflow module
  inline/imported tasks
```

The exact filesystem conventions are implementation details and may evolve.

Task and Workflow definitions remain ordinary TypeScript values.

Composition uses ordinary TypeScript imports:

```ts
import {
  investigate,
  implement,
  verify,
} from "./tasks"
```

A workflow may also define a new task locally and use it immediately:

```ts
const inspectLockfile = defineTask({
  id: "inspect-lockfile",
  input: lockfileInput,
  output: lockfileOutput,
  goal: () => "Inspect the lockfile",
})

const inspection = run(inspectLockfile, {
  // ...
})
```

No central registration step is required for local composition.

## Tasks and Workflows Share an Invocation Model

A nested workflow is invoked using the same typed model as a task.

Callers depend on the capability's input/output contract rather than whether its implementation contains one task or many.

## Discovery

Seqlane provides discovery so the CLI can list and resolve reusable workflows from supported scopes.

Discovery is separate from execution semantics.

A discovery/catalog feature is not the source of truth for TypeScript composition; normal imports are.

The MVP requires basic repository and user workflow discovery.

Generated typed catalogs or virtual import modules are deferred.

## Name Ambiguity

Capabilities from different scopes must not silently shadow one another.

If discovery finds:

```text
repository:review
user:review
```

then an unqualified lookup for `review` is ambiguous.

The CLI must surface the ambiguity or require explicit qualification rather than relying on hidden precedence.

This rule applies to discovery names; normal TypeScript import semantics remain normal TypeScript.

## Distribution

Seqlane does not introduce its own package manager.

Future reusable bundles may be distributed through normal TypeScript/npm packages.

Repository installation of Seqlane itself is expected to use the normal package-manager/dev-dependency model.

User-level workflow compatibility across different repository-pinned Seqlane versions remains a future compatibility concern.

## Consequences

### Positive

- Repository teams can encode repository-specific automation.
- Engineers can retain reusable personal workflows.
- New workflows can be assembled from existing pieces with normal TypeScript.
- No proprietary registration or package system is required.
- Nested workflows naturally support higher-level opinionated flows.
- Ambiguous discovery does not create surprising behavior.

### Negative

- User-level capabilities create future version-compatibility questions.
- Discovery across scopes requires naming and resolution rules.
- TypeScript imports and CLI discovery are related but separate mechanisms.
- Cross-repository sharing may eventually require packaging conventions.

## Alternatives Considered

### Repository scope only

Simpler but prevents personal reusable workflows across repositories.

### User scope only

Cannot encode repository-owned engineering conventions with the codebase.

### Central workflow registry/service

Could simplify discovery but introduces infrastructure and registration ceremony not required initially.

### Seqlane-specific module/package system

Provides control but duplicates TypeScript and npm.

### Silent repository-over-user precedence

Convenient but hides which automation is actually executing.

## Constraints

- Locally defined tasks require no central registration.
- Composition uses ordinary TypeScript modules.
- Discovery retains capability provenance/scope.
- Ambiguous discovered names do not silently shadow.
- Discovery does not redefine task/workflow execution semantics.
- The architecture allows future npm-distributed reusable bundles without requiring them for MVP.

## Decision Test

Reconsider this ADR if repository/user scope proves insufficient, cross-scope compatibility becomes unmanageable, or organizational scale requires a central catalog.
