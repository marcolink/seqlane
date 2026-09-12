import { defineConfig } from "vitest/config";
import { workspaceAliases } from "../../vitest.shared.mts";

export default defineConfig({
  test: {
    name: "cli",
    environment: "node",
    include: ["src/**/*.spec.ts"],
    exclude: ["src/cli-entrypoints.spec.ts", "src/runner-client.spec.ts"],
  },
  resolve: { alias: workspaceAliases },
});
