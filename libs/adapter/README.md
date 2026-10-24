# @seqlane/agent-adapter

Internal adapter contracts for Seqlane agent runtimes.

The private `@seqlane/agent-adapter/private/owned-process` export owns verified
OS process identity and bounded termination. Runtime and native adapters share
this implementation.

This package is public because the `seqlane` package needs it at run time. Its
exports are not part of the supported Seqlane API. Workflow authors must use
`@seqlane/core`.

The optional `userInput` capability is false when absent. A supporting adapter
uses `AgentAdapterRequest.requestUserInput` for live questions only when the
runtime supplies it. Question and answer schemas come from `@seqlane/protocol`.
Workflow definitions do not own question schemas or native tool contracts.
