# TS-017 — Studio Vite Development and Isolated Replay

**Status:** Proposed
**Implements:** ADR-017
**Depends:** TS-013, TS-014, TS-016
**Scope:** Studio browser development and local recording replay

## 1. Objective

Provide a supported React/Vite development workflow with HMR. Provide a
Studio-started replay mode for bounded canonical recording files.

The change covers the private `apps/seqlane-studio` application. It does not
change workflow authoring, Plan serialization, runner IPC, execution, or the
canonical event contract.

## 2. Current Boundaries

The current browser application already uses React and Vite. Its production
build is served by the Node Studio service. The service owns live snapshots,
SSE, event ordering, and in-memory run state.

The CLI recording contract is a JSONL file with:

1. one `seqlane.recording` header;
2. one canonical `SeqlaneExecutionEvent` per line; and
3. one Work and Run identity with strictly increasing metadata sequence.

The recording limits are 10 MiB and 10,000 events. The recording is bounded
local developer output and contains already-redacted Seqlane display values.
Studio loads one recording at startup and holds its validated events in memory.

## 3. Development Workflow

Add a package development command for the Studio browser application:

```text
pnpm --filter @seqlane/studio-app dev
```

The Vite development server must:

- bind to `127.0.0.1`;
- use a documented development port;
- support native Vite HMR;
- proxy `/api` and `/health` to the default local Studio service; and
- serve the browser root from the client source directory.

The development server does not replace the Node Studio service. Developers
start the service with the existing `seqlane studio` command.

The production build must:

- compile TypeScript and browser assets;
- include all browser runtime dependencies in the emitted bundle;
- exclude Node service modules from browser assets;
- remain compatible with the existing `clientRoot` static-file service; and
- expose the same package export for the production `index.html`.

The package must provide documented `dev`, `build`, `preview`, `typecheck`,
and `test` commands. Nx targets must call the package commands without
creating a second build definition.

## 4. Replay Startup and URL Contract

Add an explicit replay option to the foreground Studio command:

```text
seqlane studio --replay ./seqlane-recording.jsonl
```

The command must read and validate the recording before it starts the service.
It must fail with an actionable error when the file is missing, unreadable,
oversized, malformed, or violates the canonical recording contract.

The service creates one opaque replay identifier for the loaded recording. The
CLI prints a URL with the replay identifier and debug hint:

```text
http://127.0.0.1:57694/?replay=<opaque-id>&debug=1
```

The URL must not contain the recording filesystem path. The `debug=1` value is
only a browser presentation hint. The browser must show controls only when
the query contains `debug=1` and the replay endpoint confirms replay mode.

The replay endpoint is read-only and bounded. It returns replay metadata and
the validated stream events. The browser owns the current playback position
and reduces events through the existing projection.

The endpoint is:

```text
GET /api/replay/<replay-id>
```

Its response contains:

```ts
interface StudioReplayPayload {
  readonly replayId: string;
  readonly workflowId: string;
  readonly fileName: string;
  readonly events: readonly StudioStreamEvent[];
}
```

The endpoint returns `404` when the replay ID is not active in the current
Studio process.

Replay accepts only the existing recording format. It does not define a second
Studio-specific file format.

The Studio service must validate, before it starts replay mode:

- valid UTF-8 text within 10 MiB;
- a strict `seqlane.recording` version-1 header;
- at least one event;
- no empty interior lines;
- valid canonical event JSON on every event line;
- metadata sequence starting at 1 and increasing by 1;
- unique event IDs;
- `run.started` as the first event; and
- one Work and Run identity for the complete file.

The CLI must report a useful error and must not start the service when
validation fails. The browser must report a useful endpoint error and keep the
current live and replay state unchanged if replay metadata cannot load.

The service converts each canonical event into the existing Studio stream shape
using the recording event position as the local stream cursor:

```ts
interface StudioReplayRecording {
  readonly workflowId: string;
  readonly events: readonly StudioStreamEvent[];
}
```

The conversion does not mutate the canonical event. The workflow ID comes
from the recording header. The event Work and Run IDs remain authoritative.

The browser does not read the recording file directly and does not import Node
filesystem or CLI recording modules.

## 5. Replay State Machine

Replay state contains the opaque source ID, source file name, validated event
list, current event position, playback state, speed, and a browser projection.

```ts
type ReplayPlayback = "paused" | "playing" | "complete";

interface StudioReplaySession {
  readonly replayId: string;
  readonly fileName: string;
  readonly recording: StudioReplayRecording;
  readonly position: number;
  readonly playback: ReplayPlayback;
  readonly speed: 1 | 2 | 4;
  readonly projection: StudioBrowserState;
}
```

Required behavior:

| Action | Result |
| --- | --- |
| Load | Fetch validated replay metadata, select replay mode, set position to zero, and pause. |
| Play | Apply events in order at the selected speed. |
| Pause | Stop before the next event. |
| Step | Apply exactly one event while paused. |
| Reset | Clear the replay projection and set position to zero. |
| Complete | Stop after the last event and show the complete state. |
| Exit | Discard replay state and restore the previous live selection. |

The first version uses event steps as the deterministic playback unit. It does
not interpolate event time or provide arbitrary timeline seeking.

## 6. Live and Replay Isolation

The browser maintains separate live and replay browser states. Live SSE
events continue to update the live state while replay mode is active, but they
are not rendered in the replay view.

Replay mode must not:

- call `POST /api/events`;
- read a filesystem path from the URL;
- open a second live event stream;
- call workflow or runner APIs;
- alter the Node Studio registry; or
- alter live run selection, snapshots, or timeline data.

Exiting replay restores the live run that was selected before replay began.
If that run no longer exists, the browser selects the first available live
run.

## 7. Browser UI

The browser must provide:

- a visible replay entry point in the startup URL;
- a replay-mode indicator;
- a debug-controls indicator when `debug=1` is active;
- source file name and event position;
- Play and Pause controls;
- a Step control;
- a Reset control;
- a speed selector with 1x, 2x, and 4x values;
- an Exit replay control; and
- accessible error and completion states.

The existing read-only graph, inspector, invocation list, and timeline must
render the replay projection without replay-specific duplicate components.

## 8. Package and Boundary Rules

- Browser code can import only browser-safe package exports.
- Browser code must not import CLI recording or Node filesystem modules.
- `seqlane-core` and serialized Plans remain free of Mastra and executors.
- `seqlane-studio` remains the owner of browser-facing Studio types.
- The canonical event decoder remains in `@seqlane/events`.
- No relative source or `dist` import crosses a package boundary.

## 9. Required Tests

Add tests that prove:

- Vite development configuration serves the client and proxies API routes;
- production build emits a self-contained browser bundle;
- valid startup recordings convert to projection-ready stream events;
- malformed JSON, headers, events, sequences, identities, empty files, and
  size limits are rejected;
- the projection after a complete replay matches live projection output;
- pause stops event application;
- step applies one event;
- reset clears replay state;
- completion stops playback;
- live and replay states do not mix; and
- replay does not call the Studio ingestion endpoint;
- `debug=1` alone does not show controls without an active replay source; and
- filesystem paths never appear in generated replay URLs.

Run the test-mapping check before the affected test suites. Run Studio unit
tests, type checks, production build, and the relevant workspace boundary
checks.

## 10. Documentation

Update:

- `apps/seqlane-studio/README.md` with live, HMR, and startup replay workflows;
- the root docs index with ADR-017 and TS-017;
- the TS-017 story index; and
- any CLI recording examples that describe browser replay.

Document that replay is local, read-only, bounded, non-persistent, and cannot
resume workflow execution. Document that `debug=1` controls visibility only.

## 11. Delivery Order

1. Add the Vite development command and proxy contract.
2. Prove the production bundle and static service path.
3. Add Studio startup replay loading and validation.
4. Add replay state transitions and browser controls.
5. Verify live/replay isolation and update documentation.
