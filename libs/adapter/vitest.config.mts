import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "seqlane-agent-adapter",
    environment: "node",
    include: ["src/**/*.spec.ts"],
  },
});
