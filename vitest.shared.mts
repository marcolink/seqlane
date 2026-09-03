import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const workspaceRoot = fileURLToPath(new URL(".", import.meta.url));

export const workspaceAliases = [
  {
    find: "@seqlane/core/models",
    replacement: resolve(
      workspaceRoot,
      "libs/seqlane-core/src/models/index.ts",
    ),
  },
  {
    find: "@seqlane/core",
    replacement: resolve(workspaceRoot, "libs/seqlane-core/src/index.ts"),
  },
  {
    find: "@seqlane/events",
    replacement: resolve(workspaceRoot, "libs/seqlane-events/src/index.ts"),
  },
  {
    find: "@seqlane/fixtures/mixed-workflow",
    replacement: resolve(
      workspaceRoot,
      "libs/seqlane-fixtures/src/mixed-workflow.ts",
    ),
  },
  {
    find: "@seqlane/fixtures/renovate-fake-workflow",
    replacement: resolve(
      workspaceRoot,
      "libs/seqlane-fixtures/src/renovate-fake-workflow.ts",
    ),
  },
  {
    find: "@seqlane/fixtures/renovate-workflow",
    replacement: resolve(
      workspaceRoot,
      "libs/seqlane-fixtures/src/renovate-workflow.ts",
    ),
  },
  {
    find: "@seqlane/fixtures/validation-workflow",
    replacement: resolve(
      workspaceRoot,
      "libs/seqlane-fixtures/src/validation-workflow.ts",
    ),
  },
  {
    find: "@seqlane/fixtures/model-selection-workflow",
    replacement: resolve(
      workspaceRoot,
      "libs/seqlane-fixtures/src/model-selection-workflow.ts",
    ),
  },
  {
    find: "@seqlane/opencode",
    replacement: resolve(workspaceRoot, "libs/seqlane-opencode/src/index.ts"),
  },
  {
    find: "@seqlane/output",
    replacement: resolve(workspaceRoot, "libs/seqlane-output/src/index.ts"),
  },
  {
    find: "@seqlane/runtime/runner-package",
    replacement: resolve(
      workspaceRoot,
      "libs/seqlane-runtime/src/runner-package.ts",
    ),
  },
  {
    find: "@seqlane/runtime/runner",
    replacement: resolve(
      workspaceRoot,
      "libs/seqlane-runtime/src/runner/main.ts",
    ),
  },
  {
    find: "@seqlane/runtime",
    replacement: resolve(workspaceRoot, "libs/seqlane-runtime/src/index.ts"),
  },
  {
    find: "@seqlane/studio/protocol",
    replacement: resolve(workspaceRoot, "libs/seqlane-studio/src/protocol.ts"),
  },
  {
    find: "@seqlane/studio",
    replacement: resolve(workspaceRoot, "libs/seqlane-studio/src/service.ts"),
  },
];
