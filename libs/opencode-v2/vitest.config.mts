import { defineConfig } from "vitest/config";
import { workspaceAliases } from "../../vitest.shared.mts";

export default defineConfig({
  test: {
    name: "opencode-v2",
    environment: "node",
    include: ["src/**/*.spec.ts"],
  },
  resolve: { alias: workspaceAliases },
});
