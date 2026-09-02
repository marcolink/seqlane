# @seqlane/output

Private renderers for Seqlane execution events.

The package converts canonical `SeqlaneExecutionEvent` values into human
terminal, continuous-integration, or JSON output. It does not execute
workflows and it does not depend on a runtime adapter or executor.

## Renderer modes

- `human` shows a terminal-friendly execution tree.
- `ci` writes stable status and failure output for automation.
- `json` writes one canonical execution event per line.

The CLI selects these modes with `--output auto|human|ci|json`.

Validation invocations retain their identity, verdict, issues, and bounded
evidence in human and CI output. JSON mode preserves the same redacted
execution events for machine consumers.

## Use the package

```ts
import {
  createExecutionRenderer,
  type OutputCapabilities,
} from "@seqlane/output";
```

Pass a renderer a declared `OutputCapabilities` value, call `handle` for each
canonical execution event, and call `finish` after the run ends. Renderers
accept only `@seqlane/events` values.
