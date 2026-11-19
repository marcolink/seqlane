# @seqlane/agent-adapter

Internal adapter contracts for Seqlane agent runtimes.

The private `@seqlane/agent-adapter/private/owned-process` export owns verified
OS process identity, bounded termination, and HTTP startup readiness. Native
adapters and Actions share this implementation. Readiness owns two-second
request deadlines, retries, request aborts, and response-body cleanup within
the caller's total startup budget. Callers supply endpoint discovery,
authentication, and process-lifecycle checks. Lifecycle failures stop polling
immediately. Readiness timeout errors preserve the last probe failure.

This package is public because the `seqlane` package needs it at run time. Its
exports are not part of the supported Seqlane API. Workflow authors must use
`@seqlane/core`.

The optional `userInput` capability is false when absent. A supporting adapter
uses `AgentAdapterRequest.requestUserInput` for live questions only when the
runtime supplies it. Question and answer schemas come from `@seqlane/protocol`.
Workflow definitions do not own question schemas or native tool contracts.
