import assert from "node:assert/strict";
import test from "node:test";

import { classifyPaths } from "./classify-ci-paths.mjs";

test("fails open for an empty diff", () => {
  assert.deepEqual(classifyPaths([]), {
    bundle_relevant: "true",
    ripwire_relevant: "true",
  });
});

test("keeps documentation-only changes lightweight", () => {
  assert.deepEqual(
    classifyPaths(["README.md", "docs/ci.md", ".changeset/example.md"]),
    {
      bundle_relevant: "false",
      ripwire_relevant: "false",
    },
  );
});

test("keeps application-only changes lightweight", () => {
  assert.deepEqual(classifyPaths(["apps/cli/src/main.ts"]), {
    bundle_relevant: "false",
    ripwire_relevant: "false",
  });
});

test("marks Action and shared dependency changes as relevant", () => {
  assert.deepEqual(classifyPaths(["actions/example/src/main.ts"]), {
    bundle_relevant: "true",
    ripwire_relevant: "false",
  });
  assert.deepEqual(classifyPaths(["libs/seqlane-core/src/index.ts"]), {
    bundle_relevant: "true",
    ripwire_relevant: "false",
  });
  assert.deepEqual(classifyPaths(["pnpm-lock.yaml"]), {
    bundle_relevant: "true",
    ripwire_relevant: "false",
  });
});

test("marks Ripwire paths relevant without widening unrelated known paths", () => {
  assert.deepEqual(classifyPaths(["actions/ripwire-server/src/main.ts"]), {
    bundle_relevant: "true",
    ripwire_relevant: "true",
  });
  assert.deepEqual(
    classifyPaths(["libs/action-service-lifecycle/src/process.ts"]),
    {
      bundle_relevant: "true",
      ripwire_relevant: "true",
    },
  );
});

test("only relevant workflow changes trigger expensive checks", () => {
  assert.deepEqual(classifyPaths([".github/workflows/lint.yml"]), {
    bundle_relevant: "false",
    ripwire_relevant: "false",
  });
  assert.deepEqual(classifyPaths([".github/workflows/bundle-drift.yml"]), {
    bundle_relevant: "true",
    ripwire_relevant: "false",
  });
  assert.deepEqual(classifyPaths([".github/workflows/unit-tests.yml"]), {
    bundle_relevant: "false",
    ripwire_relevant: "true",
  });
});

test("fails open for an unknown path", () => {
  assert.deepEqual(classifyPaths(["new-top-level-file.txt"]), {
    bundle_relevant: "true",
    ripwire_relevant: "true",
  });
});
