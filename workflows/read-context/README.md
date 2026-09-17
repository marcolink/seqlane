# Read context

Builds bounded, cited repository context from exact search and configured
retrieval tools, then summarizes that evidence.

Run: `seqlane run workflows/read-context/workflow.ts --input '{"question":"where is workflow loading implemented?"}' --adapter opencode`

Input follows `ReadContextRequest`; output follows `ReadContextResult`, with
cited evidence and uncertainty metadata. It requires the configured repository
retrieval tools and an installed and authenticated OpenCode adapter. Consumers own their hook or host adaptation;
this directory owns only the portable workflow graph.
