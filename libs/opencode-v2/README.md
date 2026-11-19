# @seqlane/opencode-v2-adapter

Private OpenCode 2 adapter used by the Seqlane CLI. This package is published
so `seqlane` can install it. Its exports are not a supported authoring API.
Workflow authors use `@seqlane/core`.

The adapter uses the OpenCode 2 API and checks server compatibility before
submitting work. It implements the existing generic adapter contract. The
generic runtime has no concrete adapter dependency. The OpenCode 1 adapter
remains separate.

Execution creates a native session with the selected model, admits one input,
then polls bounded message pages through that exact input. It validates native
responses with Zod and returns one locally validated JSON value. It never
repairs output by replaying task instructions. Native configuration controls
tools and permissions. Pending forms or permissions fail without a reply.

Each prompt includes task input under `Task input:`. Input must be a JSON value.
Cyclic values, `undefined`, BigInt, and non-finite numbers fail before native
session creation. Serialized input has a 1 MiB UTF-8 limit.

Ordered reuse, model and variant validation, activity, and per-invocation usage
are supported. Assistant responses must match the session's provider, model,
and reasoning variant. An omitted selected variant fails the invocation.
Checkpoint, fork, and session UI remain disabled. Native V2
fork boundaries require separate compatibility proof.

Cancellation interrupts the owned session tree, removes shells whose native
metadata identifies an owned session, and confirms termination. Unknown shell
ownership fails closed. It never kills unrelated external work. Managed mode
owns one authenticated foreground process group on macOS or Linux. External
mode never stops the supplied service.

Managed version probing and server startup inherit only `PATH`, `HOME`,
temporary-directory variables, `LANG`, `LC_ALL`, `TZ`, the four XDG directory
variables, and `OPENCODE_DISABLE_PROJECT_CONFIG`. To pass provider credentials
or other required runtime settings, list their names in the private
`SEQLANE_OPENCODE_V2_ENV` variable:

```sh
export SEQLANE_OPENCODE_V2_ENV=OPENAI_API_KEY,HTTPS_PROXY
```

The list accepts at most 128 comma-separated variable names. It does not accept
wildcards. Unlisted credentials and process hooks do not enter the server or
its inherited shell environment. Managed mode uses native stdio startup, which
removes both server password variables before tools start. The owned client
keeps authenticated access. Explicitly selected provider values remain available
to native tools. This policy does not restrict access to credential files under
`HOME` or the XDG directories. External mode
uses the environment of the existing service.

Responses are bounded to 1 MiB before client JSON decoding. One invocation
read covers at most 1000 messages. A session tree contains at most 128 sessions.
Child session pages must add a session while a cursor remains. Pending permission
and form checks cover at most 16 sessions at once. Status polling waits one
second between reads. Requests have a 10-second bound; task cancellation also
bounds monitoring.
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
typed output, and selected reasoning variants.
It also covers Basic authentication, server password isolation from native shells,
native parent/child background-shell ownership, and cancellation cleanup.
The separate CI job runs it on the pinned Linux binary.
