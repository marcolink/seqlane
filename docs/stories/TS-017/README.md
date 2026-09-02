# TS-017 Implementation Stories

1. [TS-017-00 — Run Studio with Vite HMR](TS-017-00-vite-development-and-hmr.md)
2. [TS-017-01 — Ship a self-contained Studio browser bundle](TS-017-01-self-contained-browser-bundle.md)
3. [TS-017-02 — Start Studio with a validated replay file](TS-017-02-load-and-validate-replay-files.md)
4. [TS-017-03 — Pause and resume isolated Studio replay](TS-017-03-pause-and-resume-isolated-replay.md)
5. [TS-017-04 — Verify boundaries and document Studio workflows](TS-017-04-verify-and-document-studio-workflows.md)

## Delivery order

Stories are ordered by dependency. The Vite development and bundle stories
establish the browser runtime. The replay stories use the existing canonical
recording and Studio projection contracts. The final story verifies package
boundaries and documentation.

## Deferred

Arbitrary timeline seeking, replay editing, replay persistence, multi-run
recordings, workflow continuation, remote replay files, and executor
transcript replay remain outside TS-017.
