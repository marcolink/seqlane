# TS-013-00 — Bootstrap the Foreground Studio Application

**Status:** completed

## Use Case

**As a** Seqlane user, **I want** to start a local Studio session, **so that**
selected runs have one browser destination.

## Scope

- Create the private `apps/seqlane-studio` application.
- Create separate Node-service and browser-client runtime layers in that app.
- Create a browser-safe shared Studio protocol module.
- Add the foreground `seqlane studio` command.
- Bind only to a loopback address on an available port.
- Create and remove a mode-`0600` session descriptor file.
- Generate the random session capability and browser bootstrap credential.
- Use native `node:http` to serve the browser shell and service health data.
- Use React 19 and existing Vite tooling for the browser client.
- Add `@xyflow/react` 12.11.3 after the dependency review.

## Out of Scope

- Runner event ingestion, run state, snapshots, SSE, and graph rendering.
- Retained session files after shutdown or background service management.
- Remote addresses, user accounts, and browser editing.

## Implementation Notes

The command remains in the foreground. It must show the browser URL and the
descriptor-file path without printing the capability. The descriptor is an
internal local-session format, not a public remote connection format.

The Node service serves Vite's built static files. Keep service-only modules
out of the browser bundle. Browser code can import only browser-safe protocol
types and public Seqlane contract types.

## Acceptance Criteria

**Scenario:** *Studio starts as a local foreground service*

- **Given:** A user starts `seqlane studio`
- **When:** The command creates a Studio session
- **Then:** The service binds only to a loopback address and remains foreground

**Scenario:** *Studio has separate runtime layers*

- **Given:** The Studio application source
- **When:** The Vite client build runs
- **Then:** The browser bundle does not include Node service modules

**Scenario:** *A descriptor grants one local session*

- **Given:** A running Studio service
- **When:** It creates the session descriptor
- **Then:** The descriptor has mode `0600` and contains the session address and capability

**Scenario:** *Studio shutdown removes transient access*

- **Given:** A Studio session with a descriptor file
- **When:** The foreground command stops
- **Then:** The service stops and removes the descriptor file

## Source

- [ADR-013 — Local Read-Only Execution Studio](../../ADR-013-local-read-only-execution-studio.md)
- [TS-013 — Local Read-Only Execution Studio](../../TS-013-local-read-only-execution-studio.md)
- [ADR-002 — Dedicated Runner Process](../../ADR-002-dedicated-runner-process.md)
