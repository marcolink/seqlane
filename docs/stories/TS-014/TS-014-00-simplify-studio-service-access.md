# TS-014-00 — Simplify Studio Service Access and Port Lifecycle

**Status:** completed

## User outcome

As a local developer, I can open Studio directly on a predictable loopback
URL without a bootstrap token, cookie, or descriptor file.

## Scope

- Use the fixed default port `57694`, with explicit port override support.
- Remove browser and CLI capability checks.
- Remove bootstrap route and descriptor file creation.
- Preserve loopback-only binding and in-memory registry behavior.

## Out of scope

- CLI `--studio` flag behavior.
- Graph UI changes.
- Remote access, persistence, or multi-user authentication.

## Implementation notes

- Update `libs/seqlane-studio/src/service.ts` and service tests.
- Keep `/health`, snapshot, SSE, and ingest endpoint shapes unchanged.
- Report port conflicts without silently selecting another port.

## Acceptance criteria

```gherkin
Scenario: Start Studio on the default port
  Given no process uses port 57694
  When a Studio session starts without a port
  Then it binds to 127.0.0.1:57694
  And its browser URL is the direct root URL
  And no descriptor file is created

Scenario: Browser accesses Studio directly
  Given a running local Studio
  When a browser requests the root and API endpoints without credentials
  Then the requests succeed
  And the browser can receive the SSE stream

Scenario: Report a port conflict
  Given another process uses the selected Studio port
  When Studio starts
  Then startup fails with the selected port in the error
  And Studio does not silently choose another port
```

## Source

- [ADR-014](../../ADR-014-local-development-studio-trust-and-lifecycle.md)
- [TS-014](../../TS-014-local-development-studio-trust-and-lifecycle.md)
