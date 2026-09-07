import assert from "node:assert/strict";
import { it } from "node:test";
import { buildReadinessArguments } from "./readiness.js";

it("binds readiness to the configured instance home", () => {
  assert.deepEqual(
    buildReadinessArguments("@zvec/zvec-grep@0.2.1", "/tmp/zvec-grep"),
    [
      "dlx",
      "@zvec/zvec-grep@0.2.1",
      "server",
      "status",
      "--check-ready",
      "--home",
      "/tmp/zvec-grep",
    ],
  );
});
