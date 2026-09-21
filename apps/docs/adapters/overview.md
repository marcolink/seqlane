# Adapters

An adapter connects Seqlane agent tasks to an agent runtime. It manages the
runtime connection, model support, session operations, structured results, and
agent activity.

The workflow does not name an adapter. For `seqlane run`, deterministic
workflows need no adapter. Select one for agent tasks.

```sh
seqlane run ./workflow.ts --input '{}' --adapter opencode
```

## Available adapters

- [OpenCode](/adapters/opencode) starts a private OpenCode 1 service or connects to a loopback external service.
- [Codex](/adapters/codex) starts a local Codex app-server process for the run.

## Capabilities

All configured adapters run agent tasks and produce structured output. Their
other capabilities differ.

Adapter support is not sufficient. The selected agent model must also support
structured output. Read [Model selection](/authoring-workflows/models).

| Adapter | Model selection | Reuse session | Branch session | Activity | Session UI |
| --- | --- | --- | --- | --- | --- |
| OpenCode | Yes | Yes | Yes | Yes | When available |
| Codex | Yes | Yes | Yes | Yes | Codex app |

Model selection applies a workflow or session model to an agent session. Reuse
continues a source session. Branching creates a session from a source
checkpoint.

Codex sessions appear as tasks in the Codex app. The Codex adapter does not
provide a browser session URL.

Seqlane checks required capabilities before agent work starts. The run stops if
a workflow needs a capability that its adapter does not provide.

Read the page for the selected adapter before you author session or model rules.
