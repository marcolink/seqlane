# Code review

Reviews a supplied Git change using parallel correctness, maintainability, and
risk lanes, then applies dispositions to the resulting report.

Run: `seqlane run workflows/code-review/workflow.ts --input '<code-review input JSON>' --runtime opencode`

Input and output are defined in `contracts.ts`; the input supplies repository,
revision, pull-request, and prior-review data, and the output is a review
report. It requires a checkout and configured model runtime. GitHub event
parsing, checkout, credentials, and publication remain in the Action consumer.

New plans use the `code-review` workflow ID and `code-review-*` task IDs.
Existing plans, recordings, and metrics retain their historical IDs and remain
self-describing; consumers must treat IDs as opaque historical data rather
than resolve old IDs through this workflow.
