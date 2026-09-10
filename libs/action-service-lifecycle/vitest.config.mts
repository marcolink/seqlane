import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "action-service-lifecycle",
    environment: "node",
    include: ["src/**/*.spec.ts"],
  },
});
