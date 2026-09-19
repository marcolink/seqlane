# All-features example

Exercises branching, reusable tasks, validation, and iterative processing in
one authoring example.

Run: `seqlane run workflows/all-features-example/workflow.ts --input '{"topic":"Seqlane","focus":"workflow design"}' --adapter opencode`

Input is `{ topic: string, focus: string }`; output contains context, policy,
validation, and polished state. All agent tasks use `openai/gpt-5.6-luna`; it
requires a configured model runtime. This is a visibly marked authoring
example, not a consumer adapter or published package.
