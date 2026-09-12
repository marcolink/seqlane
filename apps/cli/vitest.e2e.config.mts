import { defineConfig } from "vitest/config";
import { workspaceAliases } from "../../vitest.shared.mts";

export default defineConfig({
  test: {
    name: "seqlane-cli-e2e",
    environment: "node",
    include: ["src/cli-entrypoints.spec.ts", "src/runner-client.spec.ts"],
  },
  resolve: { alias: workspaceAliases },
});
