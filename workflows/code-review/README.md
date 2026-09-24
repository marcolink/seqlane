# Code review

Reviews a supplied Git change using parallel correctness, maintainability, and
risk lanes, then reconciles findings with prior review state.

The model-backed history verification, review lanes, and synthesis stages each
have a five-minute execution deadline. Other agent tasks keep the two-minute
default.

Run: `seqlane run workflows/code-review/workflow.ts --input '<code-review input JSON>' --adapter opencode`

`direct` selects Seqlane's built-in in-process agent-execution profile. The
calling process or server still owns the concrete adapter choice and its private
connection configuration.

Input and output are defined in `contracts.ts`; the input supplies repository,
revision, pull-request, and prior-review data, and the output is a review
report. It requires a checkout and configured model runtime. GitHub event
parsing, checkout, credentials, and publication remain in the Action consumer.

New plans use the `code-review` workflow ID and `code-review-*` task IDs.
Existing plans, recordings, and metrics retain their historical IDs and remain
self-describing; consumers must treat IDs as opaque historical data rather
than resolve old IDs through this workflow.
