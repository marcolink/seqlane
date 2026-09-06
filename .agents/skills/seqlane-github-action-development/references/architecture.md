# GitHub Action Architecture

Each JavaScript action is an Nx application in `actions/<name>`.

An action contains these files:

- `action.yml` defines the public inputs, outputs, and runtime entrypoint.
- `src/main.ts` adapts GitHub Actions inputs and outputs to application code.
- `project.json` defines the action targets.
- `package.json` identifies the workspace package.
- `dist/main.js` is the committed action bundle.

Use `node24` in `action.yml` unless a supported compatibility requirement
requires another runtime.

Keep `src/main.ts` small. It can read inputs, write outputs, log messages, and
translate failures into action failures. Keep reusable Git and domain behavior
outside this file.

The `actions/AGENTS.md` guide reserves `packages/*` for new shared action
implementation. This workspace does not currently have a `packages/` source
root. Do not add one unless the task explicitly introduces that boundary.
Reuse an existing `libs/seqlane-*` package only when its ownership matches the
behavior.

Bundle runtime dependencies into `dist/main.js`. The consuming workflow must
not install package dependencies. Commit the bundle. Do not edit it by hand.

Set the action metadata `runs.main` value to `dist/main.js`.
