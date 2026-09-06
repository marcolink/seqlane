import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "action-merge-conflict-resolution",
    environment: "node",
    include: ["src/**/*.spec.ts"],
  },
});
