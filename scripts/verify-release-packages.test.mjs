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
    dependencies: { zod: "4.6.6" },
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
          dependencies: { "@seqlane/read-context-workflow": "workspace:*" },
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
  for (const entry of [
    "package/bin/dev.js",
    "package/dist/test-fixtures/effect-native-runner.js",
    "package/dist/start-workflow-run.effect-test-support.d.ts",
    "package/dist/runtime/execution/workflow-run.test-support.js.map",
    "package/dist/runtime/operations/host-crash-fixture.js",
    "package/dist/session-monitor-fixture.d.ts",
  ]) {
    assert.throws(
      () => validateArchiveEntries(packageName, ["package/LICENSE", entry]),
      /excluded file/,
    );
  }
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

test("requires every packed entrypoint, including the OpenCode V2 export", () => {
  const manifest = {
    name: "@seqlane/opencode-adapter",
    version: releaseVersion,
    main: "./dist/index.js",
    module: "./dist/index.js",
    types: "./dist/index.d.ts",
    exports: {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./v2": {
        types: "./dist/v2/index.d.ts",
        import: "./dist/v2/index.js",
      },
    },
  };
  const entries = [
    "package/LICENSE",
    "package/package.json",
    "package/dist/index.js",
    "package/dist/index.d.ts",
    "package/dist/v2/index.js",
    "package/dist/v2/index.d.ts",
  ];
  assert.doesNotThrow(() =>
    validatePackedManifest(manifest.name, releaseVersion, manifest, entries),
  );
  for (const missing of entries.slice(2)) {
    assert.throws(
      () =>
        validatePackedManifest(
          manifest.name,
          releaseVersion,
          manifest,
          entries.filter((entry) => entry !== missing),
        ),
      /missing entrypoint/,
    );
  }
  assert.throws(
    () =>
      validatePackedManifest(manifest.name, releaseVersion, manifest, [
        "package/LICENSE",
        "package/package.json",
      ]),
    /missing entrypoint/,
  );
});

test("requires executable entrypoints in CLI archives", () => {
  const manifest = {
    name: "seqlane",
    version: releaseVersion,
    bin: { seqlane: "bin/run.js" },
  };
  assert.throws(
    () => validatePackedManifest(manifest.name, releaseVersion, manifest, []),
    /missing entrypoint package\/bin\/run.js/,
  );
  assert.doesNotThrow(() =>
    validatePackedManifest(manifest.name, releaseVersion, manifest, [
      "package/bin/run.js",
    ]),
  );
});
