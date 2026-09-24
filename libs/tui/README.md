# @seqlane/tui

Internal terminal renderers for Seqlane execution events. This package is
public on npm so `seqlane` can install it. Its exports are not a supported API.

The package converts canonical `SeqlaneExecutionEvent` values into human or
continuous-integration terminal output. It does not execute workflows and it
does not depend on a runtime adapter or executor.

## Renderer modes

- `human` shows a passive live execution tree with automatic expansion,
  type colors, bright running rows, muted inactive rows, branch rails, right-aligned timing, resize,
  no-color, and ASCII support. Each task keeps fixed model, workspace, and
  session metadata visible when available. Active rows show only the current
  progress, tool, and skill events. It shows complete task input and result
  values and keeps the latest full activity payload visible after completion.
  A live activity update replaces the prior event with the same activity ID.
  Completed rows retain full task and activity values beside a four-line
  summary: fixed metadata;
  total tokens and cost; input/output/reasoning/cache-read/cache-write token
  buckets; and
  per-tool/per-skill counts. Duration stays right-aligned with the task title.
  Keys are muted and values use bright contrast when ANSI is available. Tool
  and skill counts represent logical activity IDs, not streamed lifecycle
  updates. Completed activity-only tasks keep their usage rows. Completed
  workflow and loop branches stay expanded so child summaries remain visible.
  Rails stretch with wrapped details.
  A task duration starts when the task becomes active. It excludes queue time and
  dependency wait time.
  Missing optional fields stay hidden. Successful rows retain task values and
  show duration and usage totals.
- `ci` writes concise, append-only status and failure output for automation.

The CLI selects these modes with `--output auto|human|ci`. Final run results
use Oclif's native `run --json` contract, and event streams use recording or
replay `--events ndjson`.

Validation invocations retain their identity, verdict, issues, and bounded
evidence in human and CI output.

CI mode consumes the complete event stream and writes each invocation input,
result, and activity event as a complete JSON line. These values are not
redacted or truncated and can contain sensitive task data. Transient output
remains on its separate channel. Task start and terminal lines use
bold ANSI styling only when the CLI reports ANSI support. Terminal task lines
include elapsed time and available token totals with input, output, reasoning,
and cache breakdowns. When the caller explicitly enables the GitHub Actions
capability, invocation and run failures also produce workflow annotations. The
final log and GitHub summary include one duration entry for
each completed leaf task; workflow and loop aggregates are excluded to avoid
double-counting. Runner supervision failures are also rendered as failed
outcomes before finalization.

## Use the package

```ts
import { createExecutionRenderer, type OutputCapabilities } from "@seqlane/tui";
```

Pass a renderer a declared `OutputCapabilities` value, call `handle` for each
canonical execution event, and call `finish` after the run ends. Renderers
accept only `@seqlane/protocol` values.

The CLI owns ordinary signal cancellation. Ink owns layout, animation,
resize, frame limiting, and terminal cleanup through its standard hooks and
render options. Mounted component tests use ink-testing-library.

The package root exposes the renderer factory and its consumer types. Concrete
renderers and run-projection types stay private.
