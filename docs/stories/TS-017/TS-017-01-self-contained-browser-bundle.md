# TS-017-01 — Ship a Self-Contained Studio Browser Bundle

**Status:** completed

## Summary

Make the packaged Studio browser assets work without runtime package imports.

## Use Case

**As a** Seqlane user, **I want to** open the packaged Studio browser, **so
that** the UI loads from the existing local service with all required browser
dependencies.

## Acceptance Criteria

**Scenario:** *The production build includes browser dependencies*

- **Given:** The Studio application has React and workspace browser imports
- **When:** The production build runs
- **Then:** The emitted browser assets include the required runtime code

**Scenario:** *The Node service serves the production build*

- **Given:** The production bundle exists at the package client export
- **When:** The local Studio service serves `/`
- **Then:** The browser loads without Node-only modules or development imports

**Scenario:** *The browser bundle excludes service code*

- **Given:** The service contains Node HTTP and filesystem modules
- **When:** The browser bundle is inspected
- **Then:** Node service modules are not included in browser assets

## Technical Details

Keep the existing `clientRoot` package export and static service path. Use the
Vite production build as the only browser bundle definition. Add package and
Nx checks for build and typecheck behavior.

## Out of Scope

- Changing package publication policy
- Bundling the Node Studio service into the browser
- Adding code splitting without measured need

## Source

- [ADR-017](../../ADR-017-studio-vite-development-and-isolated-replay.md)
- [TS-017](../../TS-017-studio-vite-development-and-isolated-replay.md)
- [ADR-013](../../ADR-013-local-read-only-execution-studio.md)
