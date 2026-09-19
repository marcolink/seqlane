# Shell tasks

A shell task runs one local executable with an argument list. It does not use a
shell, command string, or background process.

```ts
import { defineShellTask } from "@seqlane/core";
import { z } from "zod";

const status = defineShellTask({
  id: "git-status",
  input: z.object({}),
  executable: "git",
  argv: () => ["status", "--porcelain=v1"],
  timeoutMs: 10_000,
});
```

`argv` receives typed task input and returns process arguments.
`timeoutMs` is optional. The runtime uses 30 seconds by default and accepts at
most five minutes.

The task result has this shape:

```ts
{
  exitCode: number;
  stdout: string;
  stderr: string;
}
```

A nonzero exit code is a task result. Use `onError` to convert a spawn error,
timeout, or output-limit error to a normal task result. Cancellation always
stops the task.

```ts
const status = defineShellTask({
  id: "git-status",
  input: z.object({}),
  executable: "git",
  argv: () => ["status", "--porcelain=v1"],
  onError: () => ({
    exitCode: 1,
    stdout: "",
    stderr: "git status did not complete",
  }),
});
```

Shell tasks use the workflow workspace. Workspace policy controls scheduling,
not process permissions. The runtime has no shell API, Git helper, or
background-process API.
