# Minimal example

Shows a two-step agent workflow.

Run: `seqlane run workflows/minimal-example/workflow.ts --input '{"topic":"Seqlane"}' --adapter opencode`

Input is `{ topic: string }`; output is `{ answer: string }`. It requires a
configured model runtime. This is a visibly marked authoring example, not a
consumer adapter or published package.
