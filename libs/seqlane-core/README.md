# @seqlane/core

Public Seqlane contracts and serializable Plan IR.

This package is intentionally independent of Mastra. Runtime integration belongs in `@seqlane/runtime` and must not leak into this public boundary.

`SeqlaneSchema` is the small Mastra-independent schema contract used by the
runtime to validate external task inputs and outputs.

### Model catalog

Run `pnpm models:update` to refresh the committed model ID mirrors from
models.dev. The generated catalog includes strict OpenAI and Anthropic IDs;
other providers are intentionally left to generic string model references.

Model selections are nested under new or branched sessions:

```ts
import { isolated } from "@seqlane/core";
import { openai } from "@seqlane/core/models";

const session = isolated({
  model: openai("gpt-5.6-luna"),
  reasoning: "high",
});
```

Reuse sessions cannot select a model; they inherit the source session model.

Use `defineTask` and `defineWorkflow` to declare typed, core-owned authoring
definitions. Definitions keep schemas and build callbacks in memory; they are
not part of the serializable Plan IR. Local Studio displays bounded input,
result, and executor-activity values by default. Optional
`observability.studio` metadata selects
JSON Pointer paths for stricter field-level display; it does not add executor
data to a Plan.

Tasks are agent-oriented and declare a dynamic `goal` plus optional
`instructions` and `references`. These fields describe requested work without
selecting an executor or carrying runtime connection data.

Agent task handles also expose an opaque `.session` checkpoint. Omit `session`
for a fresh session (the same as `isolated()`), use `reuse(source.session)` to
continue one session, or `branch(source.session)` to create a diverging child.
Both reuse and branch infer the source dependency; a checkpoint has one reuse
consumer and any number of branch consumers. Mechanical task handles do not
expose `.session`.

### Local tasks

Use `defineTask` with `execute` for deterministic work that does not need an
agent. Use `goal` for an agent task; a definition must use exactly one of these
fields. A local task returns an output-only handle, so it cannot select a
session, model, or token-producing executor.

The local context exposes only direct executable and argv invocation:

```ts
import { defineTask } from "@seqlane/core";
import { z } from "zod";

const gitStatus = defineTask({
  id: "git-status",
  input: z.object({}),
  output: z.object({
    exitCode: z.number(),
    stdout: z.string(),
    stderr: z.string(),
  }),
  execute: async (_input, { exec }) =>
    exec({ command: "git", args: ["status", "--porcelain=v1"] }),
});
```

`exec` uses the canonical workflow workspace and does not invoke a shell. It
captures bounded stdout and stderr. Local tasks must await foreground,
non-interactive commands. The V1 API has no Git helper or mutation APIs, shell
support, background process API, or command policy.

This fan-out/fan-in workflow shares source context without merging session
histories. The synthesis task explicitly reuses `context`; branch outputs are
ordinary typed inputs.

```ts
import { branch, reuse } from "@seqlane/core";

const workflow = defineWorkflow({
  id: "research-and-implement",
  input: inputSchema,
  output: implementationSchema,
  build: ({ input, run }) => {
    const context = run(gatherContext, { input });
    const api = run(analyzeApi, {
      input,
      session: branch(context.session),
    });
    const ui = run(analyzeUi, {
      input,
      session: branch(context.session),
    });
    const synthesis = run(synthesize, {
      input: { api: api.output, ui: ui.output },
      session: reuse(context.session),
    });
    return run(implement, {
      input: { synthesis: synthesis.output },
      session: reuse(synthesis.session),
    }).output;
  },
});
```

Seqlane materializes declared branches before the parent session can advance.
Branching needs an executor-native checkpoint fork; Seqlane rejects an adapter
that cannot provide one rather than summarizing context or starting empty.

Use `reuse()` when a code review needs the implementation session context. The
review task waits for the implementation task and continues its exact session.

```ts
const implementation = run(implement, { input });
const review = run(codeReview, {
  input: { changes: implementation.output },
  session: reuse(implementation.session),
});
```

Tasks may declare `workspace: "shared" | "exclusive"`; omission defaults to
`"exclusive"` in the serialized Plan. This is a scheduling declaration only.
It does not select an executor, grant or restrict tool access, or guarantee
read-only filesystem behavior. Runtime configuration remains authoritative for
executor permissions.

Use `buildPlan` to construct a static DAG. Task output and workflow input refs
infer dependencies and serialize as `{ type, nodeId, path }` data. Use
`dependsOn` with a prior invocation when a task needs an order but does not use
its output. `nodeId` is a static Plan address, not an execution identity.

For fluent authoring, use `createFlow({ id, input, output })`. Add named tasks
with `.task(name, definition, binding)`, select the final value with
`.output(binding)`, then call `.define()`. Names are source-only aliases;
references and explicit `dependsOn` entries, not call order, create
dependencies. Flow `dependsOn` entries name prior task handles. `.repeat()`
creates a bounded post-condition repeat and retains only typed handles during
authoring.

Executors use `InteractionRequiredError` when work cannot continue without a
human decision. Its finite requirement kind is local to the executor boundary;
the message is safe to pass through Seqlane failure handling.

Serialized execution events belong to `@seqlane/events`, not this
package. They identify both the runtime `invocationId` and its static
`planNodeId`. Validated task inputs and results use Seqlane-owned display
values with explicit present, omitted, redacted, or truncated states.
