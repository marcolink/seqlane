# @seqlane/fixtures

Private workflows and task definitions for tests and local development.

The package includes workflows for Renovate-shaped execution, mixed agent and
operation work, model-selected sessions, fake execution paths, and semantic
validation coverage. It is not a production workflow catalog.

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
```

Run the Renovate fixture from the repository after a runtime service starts:

```sh
pnpm exec node apps/seqlane-cli/bin/run.js run \
  @seqlane/fixtures/renovate-workflow#renovateWorkflow \
  --input '{"dependency":"zod","fromVersion":"3","toVersion":"4","failure":"tests fail"}' \
  --runtime http://127.0.0.1:4096
```

Use only the exported subpaths in `package.json`. Do not import fixture source
files or `dist` files through relative paths.
