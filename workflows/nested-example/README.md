# Nested example

Shows a workflow calling a reusable child workflow.

Run: `seqlane run workflows/nested-example/workflow.ts --input '{"values":[1,2,3]}'`

Input is `{ values: number[] }`; output is `{ total: number, summary: string }`.
It requires only the Seqlane CLI. This is a visibly marked authoring example,
not a consumer adapter or published package.
