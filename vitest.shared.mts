import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const workspaceRoot = fileURLToPath(new URL(".", import.meta.url));

export const workspaceAliases = [
  {
    find: "@seqlane/agent-adapter",
    replacement: resolve(workspaceRoot, "libs/adapter/src/index.ts"),
  },
  {
    find: "@seqlane/acp-adapter",
    replacement: resolve(workspaceRoot, "libs/acp/src/index.ts"),
  },
  {
    find: "@seqlane/core/models",
    replacement: resolve(workspaceRoot, "libs/core/src/models/index.ts"),
  },
  {
    find: "@seqlane/core",
    replacement: resolve(workspaceRoot, "libs/core/src/index.ts"),
  },
  {
    find: "@seqlane/protocol",
    replacement: resolve(workspaceRoot, "libs/protocol/src/index.ts"),
  },
  {
    find: "@seqlane/fixtures/mixed-workflow",
    replacement: resolve(workspaceRoot, "libs/fixtures/src/mixed-workflow.ts"),
  },
  {
    find: "@seqlane/fixtures/renovate-fake-workflow",
    replacement: resolve(
      workspaceRoot,
      "libs/fixtures/src/renovate-fake-workflow.ts",
    ),
  },
  {
    find: "@seqlane/fixtures/renovate-workflow",
    replacement: resolve(
      workspaceRoot,
      "libs/fixtures/src/renovate-workflow.ts",
    ),
  },
  {
    find: "@seqlane/fixtures/validation-workflow",
    replacement: resolve(
      workspaceRoot,
      "libs/fixtures/src/validation-workflow.ts",
    ),
  },
  {
    find: "@seqlane/fixtures/model-selection-workflow",
    replacement: resolve(
      workspaceRoot,
      "libs/fixtures/src/model-selection-workflow.ts",
    ),
  },
  {
    find: "@seqlane/opencode-adapter/testing",
    replacement: resolve(workspaceRoot, "libs/opencode/src/testing.ts"),
  },
  {
    find: "@seqlane/opencode-adapter",
    replacement: resolve(workspaceRoot, "libs/opencode/src/index.ts"),
  },
  {
    find: "@seqlane/tui/terminal-field",
    replacement: resolve(workspaceRoot, "libs/tui/src/terminal-field.ts"),
  },
  {
    find: "@seqlane/tui",
    replacement: resolve(workspaceRoot, "libs/tui/src/index.ts"),
  },
  {
    find: "@seqlane/resolve-merge-conflicts-workflow",
    replacement: resolve(
      workspaceRoot,
      "workflows/resolve-merge-conflicts/workflow.ts",
    ),
  },
  {
    find: "@seqlane/runtime/workflows/resolve-merge-conflicts",
    replacement: resolve(
      workspaceRoot,
      "libs/runtime/src/workflows/resolve-merge-conflicts.ts",
    ),
  },
  {
    find: "@seqlane/runtime/runner-package",
    replacement: resolve(workspaceRoot, "libs/runtime/src/runner-package.ts"),
  },
  {
    find: "@seqlane/runtime/runner",
    replacement: resolve(workspaceRoot, "libs/runtime/src/runner/main.ts"),
  },
  {
    find: "@seqlane/runtime/workflow",
    replacement: resolve(
      workspaceRoot,
      "libs/runtime/src/runner/workflow/index.ts",
    ),
  },
  {
    find: "@seqlane/runtime/operational-host",
    replacement: resolve(workspaceRoot, "libs/runtime/src/operational-host.ts"),
  },
  {
    find: "@seqlane/runtime",
    replacement: resolve(workspaceRoot, "libs/runtime/src/index.ts"),
  },
];
