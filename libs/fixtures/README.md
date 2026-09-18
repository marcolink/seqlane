# @seqlane/fixtures

Private workflows and task definitions for tests and local development.

The package includes workflows for Renovate-shaped execution, mixed task work,
model-selected sessions, fake execution paths, and semantic validation
coverage. The `local-git-status` fixture demonstrates a task that uses direct
argv process execution followed by a task that calls `context.runAgent`. It is
not a production workflow catalog.

## Use a fixture

Import a workflow through its package export:

```ts
import {
  renovateWorkflow,
  createRenovatePlan,
} from "@seqlane/fixtures/renovate-workflow";

import {
  evaluatorRepeatWorkflow,
  taskOutputValidationWorkflow,
} from "@seqlane/fixtures/validation-workflow";

import { modelSelectionWorkflow } from "@seqlane/fixtures/model-selection-workflow";

import { localGitStatusWorkflow } from "@seqlane/fixtures/local-git-status";
```

Run the Renovate fixture after an OpenCode runtime starts and its Seqlane
adapter configuration is set:

```sh
export SEQLANE_RUNTIME_ADAPTER_CONFIG='{"adapter":"opencode","url":"http://127.0.0.1:4096"}'
seqlane run \
  @seqlane/fixtures/renovate-workflow#renovateWorkflow \
  --input '{"dependency":"zod","fromVersion":"3","toVersion":"4","failure":"tests fail"}' \
  --runtime direct
```

Use only the exported subpaths in `package.json`. Do not import fixture source
files or `dist` files through relative paths.

The local Git task uses `execute` with direct argv for
`git status --porcelain=v1` in the canonical workflow workspace. Workspace and
session policy are supplied at invocation sites. The command is foreground and
non-interactive, and the fixture does not add Git helpers, Git mutation APIs,
shell support, background processes, or command policy.
