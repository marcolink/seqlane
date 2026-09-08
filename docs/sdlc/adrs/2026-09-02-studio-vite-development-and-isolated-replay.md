---
id: adr.studio-vite-development-and-isolated-replay
title: Make Studio a Vite React App with Isolated Replay
status: accepted
owners:
  - core
created: 2026-09-02
updated: 2026-09-08
upstream:
  - rfc.seqlane-technical-architecture
supersedes: []
---

# Make Studio a Vite React App with Isolated Replay

## Context

The Studio browser client uses React, React Flow, and Vite. The package can
build browser assets, but it does not define a supported Vite development
workflow with HMR and a proxy to the local Studio service.

Seqlane can record canonical execution events in a bounded JSONL file. The
CLI can replay the file through existing consumers. Studio does not yet offer
a replay mode that starts from a file and exposes pause and resume controls.

The new behavior must keep the existing Studio boundary. Studio remains local,
read-only, loopback-only, in-memory, and independent of workflow execution.
Replay must use the same browser projection as live events. It must not load a
workflow, start a runner, invoke an executor, or post events to the service.

## Decision Outcome

Seqlane will support two browser modes in the private Studio application:

1. **Live mode** reads snapshots and SSE events from the local Studio service.
2. **Replay mode** starts from one canonical recording file loaded by the
   Studio service and reduces its events through the existing Studio projection.

The browser application will use Vite in both development and production:

- the Vite development server runs separately from the Node Studio service;
- the development server binds to loopback and provides HMR;
- development requests for `/api` proxy to the local Studio service;
- the production build emits a self-contained browser asset bundle;
- the Node Studio service continues to serve the production bundle; and
- React, React Flow, Zod, and workspace browser contracts remain in the bundle.

Replay mode will:

- start with `seqlane studio --replay <recording-file>`;
- validate the recording header and canonical events before the service starts;
- expose the validated recording through a bounded read-only replay endpoint;
- identify the replay source in the browser URL with an opaque `replay` value;
- use `debug=1` as a browser UI hint for replay controls;
- show controls only when the server confirms that replay mode is active;
- preserve recording sequence and run identity rules;
- keep replay projection state separate from live projection state;
- provide play, pause, single-event step, reset, and playback-speed controls;
- show the replay position and source file name; and
- return to live mode without changing live Studio state.

Replay will not expose the filesystem path in a URL. It will not upload,
persist, edit, or share the selected file. It will use the same recording size
and event limits as the CLI recording contract.

## Options Considered

### Keep the current production-only Vite build

This keeps the current packaging path, but it gives browser development no
supported HMR workflow. Developers must rebuild assets after browser changes.

### Run Vite inside the Node Studio service

This provides one process, but it mixes development middleware with the
foreground service and complicates packaged behavior. It also makes the HMR
workflow depend on service implementation details.

### Run Vite as a separate development server

This keeps browser development concerns in the browser application. The
service remains the source of live data and the production static-file server.
The proxy keeps browser requests same-origin during development.

### Replay through the CLI only

This preserves the current CLI path, but it cannot provide browser controls or
an isolated development loop for Studio UI changes.

### Browser-local replay file loading

This avoids server file access, but it requires a browser file picker and does
not support a ready-to-open replay URL from a Studio startup command.

### Start Studio with a replay file

This lets the service validate the file once and lets the CLI print a stable
replay URL. The browser still owns playback position and projection state. The
service adds one bounded read-only endpoint, but no execution control path.

## Rationale

The separate Vite server is the smallest change that provides HMR and keeps
the existing service boundary stable. Service-started replay supports a ready
URL while keeping playback position and projection state in the browser.
Reducing replay events through the existing projection keeps live and replay
behavior aligned.

## Consequences

### Positive

- Browser changes appear through HMR during local development.
- Production assets remain deployable through the existing Studio service.
- Developers can inspect recordings without starting a workflow.
- The CLI can print a ready-to-open replay URL.
- Pause and step operations make event-level debugging possible.
- Live event ingestion and replay state remain isolated.
- No new persistence, replay service, or executor boundary is required.

### Negative

- Developers run the Vite server and Studio service in development mode.
- Replay controls add browser state and UI complexity.
- The service must validate and hold one bounded recording in memory.
- Startup fails when the replay file is missing or invalid.
- Replay does not preserve progress across browser refreshes.
- The first replay version supports one recording and one run only.

## Follow-Up Constraints

- Keep Vite development access on loopback.
- Keep the production browser bundle self-contained.
- Use `@seqlane/events` decoding and the existing Studio projection.
- Accept replay files only through the explicit Studio startup option.
- Use opaque replay identifiers in URLs. Never put filesystem paths in URLs.
- Treat `debug=1` as a presentation hint, not an access-control mechanism.
- Keep replay endpoints read-only and bounded.
- Do not add workflow loading, runner control, executor data, or event upload.
- Do not mix live SSE events into replay projection state.
- Do not persist replay files or replay position in browser storage.
- Preserve the canonical recording limits and malformed-input behavior.
- Update the Studio README and architecture index with the two workflows.

## Revisit Conditions

Revisit this decision if Studio needs remote development, shared replay files,
durable replay sessions, multi-run recording files, timeline seeking, replay
of events that are not canonical Seqlane execution events, or replay controls
that affect execution.

## Delivery state

The five implementation tasks linked to this decision are completed. Current
code and documentation implement Vite HMR and isolated replay. This accepted
ADR records the architecture decision. Delivery claims still require current
target-branch implementation and reachable Git evidence.

## Traceability

- [rfc.seqlane-technical-architecture: Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
