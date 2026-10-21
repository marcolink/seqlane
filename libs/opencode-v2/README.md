# @seqlane/opencode-v2-adapter

Private OpenCode 2 adapter used by the Seqlane CLI. This package is published
so `seqlane` can install it. Its exports are not a supported authoring API.
Workflow authors use `@seqlane/core`.

The package pins `@opencode/client` and the supported native server to 2.1.2.
It implements the existing generic adapter contract. The generic runtime has
no concrete adapter dependency. The OpenCode 1 adapter remains separate.

Execution creates a native session with the selected model, admits one input,
then polls bounded message pages through that exact input. It validates native
responses with Zod and returns one locally validated JSON value. It never
repairs output by replaying task instructions. Native configuration controls
tools and permissions. Pending forms or permissions fail without a reply.

Ordered reuse, model and variant validation, activity, and per-invocation usage
are supported. Checkpoint, fork, and session UI remain disabled. Native V2
fork boundaries require separate compatibility proof.

Cancellation interrupts the owned session tree, removes shells whose native
metadata identifies an owned session, and confirms termination. Unknown shell
ownership fails closed. It never kills unrelated external work. Managed mode
owns one authenticated foreground process group on macOS or Linux. External
mode never stops the supplied service.

Responses are bounded to 1 MiB before client JSON decoding. One invocation
read covers at most 1000 messages. A session tree contains at most 128 sessions.
Requests have a 10-second bound; task cancellation also bounds monitoring.
Cleanup has a separate 5-second bound. Monitoring uses finite message reads,
not the experimental native session log or live-only global event stream.

Run deterministic fixtures after `pnpm test:mapping`:

```sh
pnpm --dir libs/opencode-v2 exec vitest run
```

The separate native compatibility probe uses a local OpenAI-compatible test
provider. It needs no paid model credential and isolates all native state.
Build the CLI first, then run:

```sh
SEQLANE_OPENCODE_V2_EXECUTABLE=/absolute/path/to/opencode node scripts/opencode-v2-compatibility.mjs
```

The probe covers managed and external compiled CLI execution, ordered reuse,
typed output, Basic authentication, native parent/child background-shell ownership, and
cancellation cleanup. The separate CI job runs it on the pinned Linux binary.
