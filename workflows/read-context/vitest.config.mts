import { defineConfig } from "vitest/config";
import { workspaceAliases } from "../../vitest.shared.mts";

export default defineConfig({
  test: {
    name: "workflow-read-context",
    environment: "node",
    include: ["src/**/*.spec.ts", "workflow.spec.ts"],
  },
  resolve: { alias: workspaceAliases },
});
