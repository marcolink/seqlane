---
id: spec.local-development-studio-trust-and-lifecycle
title: Local Development Studio Trust and Lifecycle
status: active
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - adr.local-development-studio-trust-and-lifecycle
supersedes: []
---

# Local Development Studio Trust and Lifecycle

> Migrated from legacy technical specification `TS-014`.

## 1. Objective

Simplify Studio for local development by removing browser bootstrap tokens,
browser cookies, and session descriptor files. Studio remains loopback-only,
read-only, and in-memory.

Support two modes:

- standalone Studio for multiple concurrent runs;
- one-shot Studio owned by one `seqlane run` command.

## 2. Constraints

- Bind only to `127.0.0.1`.
- No remote access, user accounts, durable storage, or daemon.
- Accept that local processes can read snapshots or inject events.
- Studio failures must not change runner results or exit status.
- Preserve spec.local-read-only-execution-studio event, redaction, bounds, and SSE behavior.
- Do not edit adr.local-read-only-execution-studio or spec.local-read-only-execution-studio historical text; this spec supersedes only
  their access, discovery, and lifecycle details.

## 3. User-facing Commands

### 3.1 Standalone Studio

```sh
seqlane studio
```

Start on `127.0.0.1:57694`, print the direct browser URL, and remain in the
foreground until `SIGINT` or `SIGTERM`. It can receive events from multiple
`seqlane run` processes.

Allow an explicit port for local conflict resolution:

```sh
seqlane studio --port 57695
```

No descriptor file is created.

### 3.2 One-shot Studio

```sh
seqlane run <workflow> --input '<json>' --runtime <runtime> --studio
```

`--studio` is a boolean flag. The command checks the configured local Studio,
reuses one that is already running, or starts one owned by the CLI. It prints
the direct browser URL, forwards runner events best effort, and stops only a
Studio instance it started after the run settles.

If standalone Studio is already running, the run must not stop it.

## 4. Service Contract

Replace descriptor startup with:

```ts
interface StudioSessionOptions {
  readonly port?: number;
  readonly clientRoot?: string;
  readonly registry?: StudioRegistry;
}

interface StudioSession {
  readonly address: string;
  readonly browserUrl: string;
  stop(): Promise<void>;
}
```

The default port is `57694`. The server always binds to `127.0.0.1`.
`browserUrl` is `address + "/"`.

Remove `bootstrapToken`, `browserCapability`, descriptor paths, and
descriptor cleanup. Remove `/bootstrap`; direct `/` serves the client.

All existing endpoints remain:

- `GET /health`
- `GET /api/runs`
- `GET /api/runs/:runId`
- `GET /api/events`
- `POST /api/events`

API requests and event ingestion no longer require cookies or
`x-seqlane-studio-capability`. Port conflicts fail clearly and suggest an
alternate `--port`.

## 5. CLI Integration

Update `apps/seqlane-cli/src/commands/studio.ts`:

- remove `--descriptor`;
- add optional `--port`;
- pass `port` to `startStudioSession`;
- print the direct browser URL only.

Update `apps/seqlane-cli/src/commands/run.ts`:

- change `--studio <descriptor-file>` to boolean `--studio`;
- resolve the local Studio address deterministically;
- start an owned session only when no existing session is available;
- publish without a capability header; and
- stop an owned session in a `finally` path after publisher shutdown.

Change the publisher API to accept a local address instead of
`StudioSessionDescriptor`.

## 6. Browser Changes

Load directly from `/` and call the existing APIs without credentials. Direct
refresh after a Studio restart must work without stale-session recovery.

The browser remains read-only with respect to execution. Graph selection is
local UI state. Node dragging and rearrangement are deferred.

## 7. Compatibility and Migration

This is a breaking local CLI change:

- `seqlane studio --descriptor <path>` is removed;
- `seqlane run --studio <path>` becomes `seqlane run --studio`;
- descriptor files are no longer created, read, or deleted;
- old bootstrap URLs return `404`; and
- direct root access no longer returns `401`.

Update READMEs, examples, tests, and spec.local-read-only-execution-studio cross-references. Do not preserve
compatibility shims unless a migration requirement appears.

## 8. Failure Handling

- Studio startup failure exits the Studio startup path with an actionable
  error.
- A port conflict reports the exact port.
- API or forwarding failure emits a diagnostic and preserves the runner
  result and exit status.
- Owned-session shutdown failure is reported after the run result is known.
- Shutdown closes SSE clients, stops the HTTP server, and discards registry
  state.

## 9. Required Tests

### Service

- default and explicit port startup;
- loopback-only binding;
- port conflict reporting;
- no descriptor creation;
- no `/bootstrap` route;
- direct unauthenticated snapshots, SSE, and event ingestion; and
- state removal after shutdown.

### CLI

- boolean `--studio` parsing;
- owned Studio startup and shutdown;
- reuse of a pre-existing standalone Studio;
- no shutdown of standalone Studio after a run;
- preserved runner result when Studio fails; and
- removal of descriptor-based examples.

### Browser

- direct root load after restart;
- refresh without bootstrap;
- live SSE updates without credentials; and
- unchanged graph, inspector, timeline, selection, and layout behavior.

## 10. Acceptance Criteria

- `seqlane studio` starts a direct loopback browser service without a
  descriptor or token.
- `seqlane run --studio` forwards events without a descriptor argument.
- Standalone Studio remains alive after an individual run.
- One-shot Studio stops only when its owning run completes.
- Direct browser access works after restart.
- The unauthenticated local trust model is documented.
- Existing redaction, bounds, SSE, event-ordering, and best-effort guarantees
  remain valid.

## 11. Delivery Order

1. Change service startup and HTTP access.
2. Change CLI flags and owned-session lifecycle.
3. Change the event publisher contract.
4. Remove browser bootstrap assumptions.
5. Update READMEs and spec.local-read-only-execution-studio cross-references.
6. Run service, CLI, browser, typecheck, lint, and format checks.

## 12. Source Decisions

- [adr.local-development-studio-trust-and-lifecycle — Simplify the Local Development Studio Trust and Lifecycle](../adrs/2026-09-02-local-development-studio-trust-and-lifecycle.md)
- [adr.local-read-only-execution-studio — Provide a Local Read-Only Execution Studio](../adrs/2026-09-02-local-read-only-execution-studio.md)
- [spec.local-read-only-execution-studio — Local Read-Only Execution Studio](./2026-09-02-local-read-only-execution-studio.md)
- [adr.dedicated-runner-process — Dedicated Runner Process](../adrs/2026-09-02-dedicated-runner-process.md)

## Traceability

- [adr.local-development-studio-trust-and-lifecycle](../adrs/2026-09-02-local-development-studio-trust-and-lifecycle.md)
