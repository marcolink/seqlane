import { defineConfig } from "vitest/config";
import { workspaceAliases } from "../../vitest.shared.mts";

export default defineConfig({
  test: {
    name: "cli",
    environment: "node",
    include: ["src/**/*.spec.ts"],
    exclude: [
      "src/cli-entrypoints.spec.ts",
      "src/runner-client.spec.ts",
      "src/effect-tracer-worker.e2e.spec.ts",
      "src/effect-dag-worker.e2e.spec.ts",
      "src/effect-session-worker.e2e.spec.ts",
      "src/effect-nested-worker.e2e.spec.ts",
      "src/effect-native-worker.e2e.spec.ts",
      "src/effect-acp-worker.e2e.spec.ts",
    ],
  },
  resolve: { alias: workspaceAliases },
});
