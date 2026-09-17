# All-features example

Exercises branching, reusable tasks, validation, and iterative processing in
one authoring example.

Run: `seqlane run workflows/all-features-example/workflow.ts --input '{"topic":"Seqlane","focus":"workflow design"}' --runtime opencode`

Input is `{ topic: string, focus: string }`; output contains context, policy,
validation, and polished state. It requires a configured model runtime. This
is a visibly marked authoring example, not a consumer adapter or published
package.
