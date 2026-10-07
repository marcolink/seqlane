import assert from "node:assert/strict";
import { chdir } from "node:process";
import { tmpdir } from "node:os";
import { verifyReviewGitHost } from "../dist/git-host-smoke.mjs";

assert.ok(
  process.env.SEQLANE_REVIEW_CGROUP_ROOT,
  "A delegated cgroup v2 root is required",
);
// Asset/source resolution must not depend on the caller's checkout directory.
chdir(tmpdir());
const evidence = await verifyReviewGitHost(
  process.env.SEQLANE_REVIEW_CGROUP_ROOT,
);
console.log(JSON.stringify(evidence));
