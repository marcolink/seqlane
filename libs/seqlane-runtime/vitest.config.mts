import { defineConfig } from "vitest/config";
import { workspaceAliases } from "../../vitest.shared.mts";

export default defineConfig({
  test: {
    name: "seqlane-runtime",
    environment: "node",
    include: ["src/**/*.spec.ts"],
  },
  resolve: { alias: workspaceAliases },
});
