# TS-017-00 — Run Studio with Vite HMR

**Status:** completed

## Summary

Give Studio developers a fast browser development loop.

## Use Case

**As a** Seqlane developer, **I want to** run the Studio browser with Vite
HMR, **so that** browser changes appear without rebuilding the production
bundle.

## Acceptance Criteria

**Scenario:** *The developer starts the browser development server*

- **Given:** The local Studio service runs on its default loopback port
- **When:** I run the documented Studio development command
- **Then:** Vite serves the React client on its documented development port

**Scenario:** *The browser keeps live API requests same-origin*

- **Given:** The Vite development server and local Studio service run together
- **When:** The client requests `/api/runs` or `/api/events`
- **Then:** Vite proxies the request to the loopback Studio service

**Scenario:** *A browser source change is saved*

- **Given:** The client is open through the Vite development server
- **When:** A client source module changes
- **Then:** Vite updates the browser through HMR without a production rebuild

## Technical Details

Add the package `dev` command and Vite loopback server configuration. Proxy
`/api` and `/health` to the existing default Studio service. Keep the Node
service as a separate process.

## Out of Scope

- Changing the Studio HTTP service
- Adding remote development access
- Adding a browser state library

## Source

- [ADR-017](../../ADR-017-studio-vite-development-and-isolated-replay.md)
- [TS-017](../../TS-017-studio-vite-development-and-isolated-replay.md)
- [ADR-014](../../ADR-014-local-development-studio-trust-and-lifecycle.md)
