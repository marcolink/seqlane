# OpenCode 2 implementation

Private OpenCode 2 adapter used by the Seqlane CLI. The
`@seqlane/opencode-adapter/v2` export contains this implementation.
Its exports are not a supported authoring API.
Workflow authors use `@seqlane/core`.

The adapter uses the OpenCode 2 API and checks server compatibility before
submitting work. It implements the existing generic adapter contract. The
generic runtime has no concrete adapter dependency. The same package contains the OpenCode 1 implementation at its root export.

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
Checkpoints and native forks are supported. Session UI remains disabled.

Checkpoint capture forks an idle native snapshot after a successful task.
The run keeps a Zod-validated registry of opaque handles, bound to their source
adapter. Repeated capture returns the same handle until the source runs again.
Empty, busy, closed, and foreign checkpoints fail before native allocation.
A snapshot failure leaves the successful task result intact. Capture reports
the failure and can retry while the source remains idle.

Deferred forks copy the saved snapshot, even after the source session changes
or a later execution fails and removes it. A failed source remains unavailable
for execution and capture. Its earlier checkpoints remain available for forks
until explicit adapter close or run cleanup.
Native `fork({ sessionID })` copies the full current history and current
instruction state. The adapter omits `before` because that boundary excludes
a message and still inherits current instructions. Freezing both in a separate
session preserves the completed task boundary. Each native fork is an
independent root. Its `parentID` is absent, and its `fork.sessionID` identifies
the copied session. Cancelling one root preserves its source and peers.

Each fork applies its selected model and reasoning through native `switchModel`,
then validates session identity, workspace, model, and idle state. Without an
explicit selection, the fork inherits the checkpoint selection. Capture and
fork never submit prompts or call a model. For example:

```ts
// Before: only ordered reuse was available.
await source.execute(first);
await source.execute(second);

// After: save the first result before reusing its source.
await source.execute(first);
const checkpoint = await source.captureCheckpoint!();
await source.execute(second);
const branch = await source.fork!({ checkpoint });
await branch.execute(third); // History contains first, then third.
```

The runtime tracks independent roots as soon as native allocation returns an ID.
It cleans partially created forks and waits for pending allocations during close.
Run cleanup removes live sessions, fork sessions, and retained snapshots.
Snapshots remain available until run cleanup. Native storage grows with the
number of captured task boundaries. Tasks without capture allocate no snapshot.
New fork orchestration uses pinned Effect programs at the SDK integration
boundary. Native allocation has a separate request bound so cancellation cannot
lose an ID that native allocation returns.

Cancellation interrupts the owned session tree, removes shells whose native
metadata identifies an owned session, and confirms termination. Unknown shell
ownership fails closed. It never kills unrelated external work. Managed mode
owns one authenticated foreground process group on macOS or Linux. External
mode never stops the supplied service.

Each started tool activity receives a terminal event. If observation ends before
native tool completion, the adapter closes that activity as failed. Cancellation
uses the same terminal state. Native cleanup still requires termination proof.
Activity events preserve tool input, output, and metadata. Changed tool details
produce small progress notifications while the tool runs. Terminal events
preserve the complete latest details. Opaque tool values have a depth limit
of 64 and a node limit of 65,536 before serialization or redaction.
Model observations preserve native reasoning and tool content. Nested values
use the same credential redaction as text output. If a nested property name
contains a configured credential, the adapter rejects the entire observation
batch before it emits activity or model observations. It reports a typed
protocol error without the unsafe name. It does not rename keys or merge
colliding names. Repeated snapshots do not duplicate terminal activity or usage.
Sanitized content passes canonical JSON validation before any batch callback.
Invalid native JSON data, including overflowing numbers, fails with a typed
protocol error. Only consumer callback failures are ignored.

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

JSON responses are bounded to 1 MiB before client decoding, including errors.
The private transport passes successful native session logs through as SSE.
It bounds each frame to 1 MiB of UTF-8 bytes and splits coalesced frames before
SDK decoding. Closing the stream cancels the underlying response reader.
One invocation
read covers at most 1000 messages. A session tree contains at most 128 sessions.
Child session pages must add a session while a cursor remains. Pending permission
and form checks cover at most 16 sessions at once. Status polling waits one
second between reads. Requests have a 10-second bound; task cancellation also
bounds monitoring.
Cleanup has a separate 5-second bound. Monitoring uses finite message reads,
not the experimental native session log or live-only global event stream.

Run deterministic fixtures after `pnpm test:mapping`:

```sh
pnpm --dir libs/opencode exec vitest run src/v2
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

Run the separate native session proof after building the adapter:

```sh
pnpm exec tsc --build libs/opencode/tsconfig.json
SEQLANE_OPENCODE_V2_EXECUTABLE=/absolute/path/to/opencode node scripts/opencode-v2-sessions-compatibility.mjs
```

This probe uses an isolated local provider with no paid model credentials.
The probe covers deferred history, native instructions, parallel forks, selected
reasoning, and cancellation that preserves peers. It also proves cleanup of
independent roots and zero model calls during capture or fork.
The earlier compatibility probe remains separate.
