# Until example

Shows a deterministic task repeated until its output reports completion.

Run: `seqlane run workflows/until-example/workflow.ts --input '{"remaining":3,"attempts":0}'`

Input is `{ remaining: positive integer, attempts: non-negative integer }`;
output reports the remaining count, attempt count, and completion state. It
requires only the Seqlane CLI. This is a visibly marked authoring example.
