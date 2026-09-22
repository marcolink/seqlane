import assert from "node:assert/strict";
import test from "node:test";

import {
  validateArchiveEntries,
  validatePackedManifest,
  validateProjectSet,
  validateSourceManifest,
} from "./verify-release-packages.mjs";

const project = "core";
const projectRoot = "libs/core";
const packageName = "@seqlane/core";
const releaseVersion = "0.0.1";

function sourceManifest(overrides = {}) {
  return {
    name: packageName,
    version: releaseVersion,
    license: "Apache-2.0",
    repository: {
      type: "git",
      url: "git+https://github.com/marcolink/seqlane.git",
      directory: projectRoot,
    },
    engines: { node: ">=24.0.0" },
    publishConfig: { access: "public", provenance: true },
    dependencies: { zod: "4.5.4" },
    ...overrides,
  };
}

test("accepts the exact release project set", () => {
  assert.doesNotThrow(() =>
    validateProjectSet("release", [
      "tui",
      "runtime",
      "protocol",
      "opencode",
      "core",
      "codex-adapter",
      "cli",
      "adapter",
    ]),
  );
  assert.throws(
    () => validateProjectSet("release", ["core", "private-package"]),
    /must contain exactly/,
  );
});

test("validates source metadata and private dependency closure", () => {
  assert.equal(
    validateSourceManifest(project, projectRoot, sourceManifest()),
    releaseVersion,
  );
  assert.throws(
    () =>
      validateSourceManifest(
        project,
        projectRoot,
        sourceManifest({
          dependencies: { "@seqlane/read-context": "workspace:*" },
        }),
      ),
    /private workspace package/,
  );
  assert.throws(
    () =>
      validateSourceManifest(
        project,
        projectRoot,
        sourceManifest({ publishConfig: { access: "public" } }),
      ),
    /invalid public package metadata/,
  );
});

test("validates archive contents", () => {
  assert.doesNotThrow(() =>
    validateArchiveEntries(packageName, [
      "package/LICENSE",
      "package/package.json",
      "package/dist/index.js",
    ]),
  );
  assert.throws(
    () =>
      validateArchiveEntries(packageName, [
        "package/LICENSE",
        "package/dist/index.spec.js",
      ]),
    /excluded file/,
  );
});

test("requires exact internal versions in packed manifests", () => {
  assert.doesNotThrow(() =>
    validatePackedManifest(packageName, releaseVersion, {
      name: packageName,
      version: releaseVersion,
      dependencies: { "@seqlane/protocol": releaseVersion },
    }),
  );
  assert.throws(
    () =>
      validatePackedManifest(packageName, releaseVersion, {
        name: packageName,
        version: releaseVersion,
        dependencies: { "@seqlane/protocol": "workspace:*" },
      }),
    /workspace dependency/,
  );
});
