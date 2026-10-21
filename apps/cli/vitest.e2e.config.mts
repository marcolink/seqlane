import { defineConfig } from "vitest/config";
import { workspaceAliases } from "../../vitest.shared.mts";

export default defineConfig({
  test: {
    name: "cli-e2e",
    environment: "node",
    include: [
      "src/cli-entrypoints.spec.ts",
      "src/runner-client.spec.ts",
      "src/effect-tracer-worker.e2e.spec.ts",
      "src/effect-dag-worker.e2e.spec.ts",
      "src/effect-session-worker.e2e.spec.ts",
    ],
  },
  resolve: { alias: workspaceAliases },
});
