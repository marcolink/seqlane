import { defineConfig } from "vitest/config";
import { workspaceAliases } from "../../vitest.shared.mts";

export default defineConfig({
  test: {
    include: ["src/client/**/*.spec.ts", "src/client/**/*.spec.tsx"],
  },
  resolve: { alias: workspaceAliases },
});
