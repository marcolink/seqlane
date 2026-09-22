# Read context

Builds bounded, cited repository context from exact search and configured
retrieval tools, then summarizes that evidence.

This private workspace package owns the retrieval logic, schemas, and workflow.
The repository-local hook adapter remains under `.codex/hooks/` and loads the
guard directly from `src/hook.ts` with Node's built-in type stripping. It does
not depend on this package build.

Run: `seqlane run workflows/read-context/workflow.ts --input '{"question":"where is workflow loading implemented?"}' --adapter codex`

Input follows `ReadContextRequest`; output follows `ReadContextResult`, with
cited evidence and uncertainty metadata. It requires the configured repository
retrieval tools and Codex model availability. It selects `openai/gpt-6-luna`
with medium reasoning. Consumers own their hook or host adaptation;
this directory owns the portable workflow and its supporting retrieval code.
