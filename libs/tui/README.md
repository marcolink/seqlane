# @seqlane/tui

Private terminal renderers for Seqlane execution events.

The package converts canonical `SeqlaneExecutionEvent` values into human or
continuous-integration terminal output. It does not execute workflows and it
does not depend on a runtime adapter or executor.

## Renderer modes

- `human` shows a passive live execution tree with automatic expansion,
  status colors, branch rails, right-aligned timing, session links, resize,
  no-color, and ASCII support. It does not read keyboard input.
- `ci` writes concise, append-only status and failure output for automation.

The CLI selects these modes with `--output auto|human|ci`. Final run results
use Oclif's native `run --json` contract, and event streams use recording or
replay `--events ndjson`.

Validation invocations retain their identity, verdict, issues, and bounded
evidence in human and CI output.

CI mode consumes the complete event stream but renders only meaningful state
changes, retries, waits, skips, persistent output, failures, heartbeats, and
the final summary. It does not print invocation input, transient output, or
routine successful tool and skill activity. Task start and terminal lines use
bold ANSI styling so the execution steps are easy to scan. Terminal task lines
include elapsed time and available token totals with input, output, reasoning,
and cache breakdowns. When the caller explicitly enables the GitHub Actions
capability, failed tool activity includes a bounded command, path, or search
detail when available, and invocation and run failures also produce workflow
annotations. The final log and GitHub summary include one duration entry for
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
