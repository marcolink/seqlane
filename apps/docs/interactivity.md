# Interactivity

An agent can discover missing information after a run starts. A skill can
also require a decision that the workflow author could not predict.
Interactive runs let the agent ask structured questions and continue with
your answers in the same invocation.

Runs are autonomous by default. Enable interactivity for each run that needs it.
Currently, only the [Codex adapter](./adapters/codex.md) supports this mode.

## Enable questions

```sh
seqlane run ./workflow.ts \
  --input '{}' \
  --adapter codex \
  --workspace . \
  --interactive \
  --input-timeout 300
```

Use the input required by your workflow instead of `{}` when needed.
Interactive execution requires human output and terminal input and output.
CI, `--json`, redirected streams, and `--input-file -` are unsupported.
A dry run validates the flags without starting an adapter or opening questions.

## How agents ask

With interactivity enabled, the agent receives an `ask_user` tool and
instructions to use it when required information remains unavailable.
This applies to skills loaded after the run starts. Questions need no static
declaration in the workflow, and the task's final output schema stays unchanged.

For example, a skill choosing a preview region can make this tool call:

```ts
ask_user({
  questions: [
    {
      id: "region",
      prompt: "Which region should host this preview?",
      options: [
        { value: "eu-west", label: "Europe" },
        { value: "us-east", label: "United States" },
      ],
      allowFreeText: false,
    },
  ],
});
```

This is an agent tool call, not a workflow API. A skill can instruct the agent:

> If the region is missing, call `ask_user` with the available choices.
> Continue only after the tool returns an answer. Do not choose for the user.

After you select Europe, the tool returns:

```json
{
  "status": "answered",
  "answers": { "region": "eu-west" }
}
```

The agent continues its current task with this answer. A prose question alone
does not open the input form.

## Answer questions

A request can contain up to eight questions. Each question accepts text,
one listed choice, or a choice with a text alternative. Every question needs
an answer before the batch is submitted. Text answers preserve spaces.

| Control                | Action                          |
| ---------------------- | ------------------------------- |
| Option number or value | Select a listed choice          |
| Enter                  | Confirm the answer and continue |
| Shift+Tab              | Return to the previous question |
| Esc, Ctrl+C, or Ctrl+D | Cancel the whole run            |

Invalid answers keep the form open for correction. Requests from independent
tasks queue in arrival order. Progress remains visible, including the pending
count and tasks waiting for input.

## Deadlines and cancellation

`--input-timeout` accepts 1–86400 seconds and defaults to 300 seconds.
It requires `--interactive`. The deadline starts when the agent asks, including
time spent in the queue. Task and run deadlines continue during the wait.
The earliest deadline wins; an input timeout fails the invocation.

Cancellation or terminal input loss cancels the run and stops the native wait.
There is no implicit skip or default answer. Pending questions exist only in
the live process; restarting the CLI cannot resume them.

## Input and permissions

Answers supply task information. They do not approve operations or change
the existing permission policy. Do not enter passwords, tokens, or other
secrets: answers reach the agent and can enter its native transcript.

See the [CLI flag reference](./cli/run.md#interactive-and-input-timeout)
for command options and the [Codex guide](./adapters/codex.md) for adapter setup.
