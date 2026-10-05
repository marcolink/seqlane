import { defineConfig } from "vitest/config";
import { workspaceAliases } from "../../vitest.shared.mts";

export default defineConfig({
  test: {
    name: "tui",
    environment: "node",
    // Avoid competing test-file workers while measuring large-plan projection.
    maxWorkers: 1,
    include: ["src/**/*.spec.{ts,tsx}"],
  },
  resolve: { alias: workspaceAliases },
});
