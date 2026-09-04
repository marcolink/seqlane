// @test-scope ./community-dependency-guards.ts

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import {
  assertNoForbiddenEnterpriseImports,
  assertNoMastraImports,
  publicPackageBoundaryFiles,
  repositoryProductionSourceFiles,
} from "./community-dependency-guards.js";

const repositoryRoot = fileURLToPath(
  new URL("../../../../../", import.meta.url),
);
const forbiddenImportFixture = fileURLToPath(
  new URL("../../../fixtures/forbidden-ee-import.ts", import.meta.url),
);
const forbiddenSyntaxFixtures = [
  "forbidden-ee-side-effect-import.ts",
  "forbidden-ee-export-from.ts",
  "forbidden-ee-require.cjs",
  "forbidden-ee-dynamic-import.ts",
].map((name) =>
  fileURLToPath(new URL(`../../../fixtures/${name}`, import.meta.url)),
);

describe("Community Mastra dependency boundary", () => {
  it("resolves the pinned Community workflow entrypoints", () => {
    expect(createStep).toEqual(expect.any(Function));
    expect(createWorkflow).toEqual(expect.any(Function));
  });

  it("keeps public package source and manifests Mastra-free", () => {
    assertNoMastraImports(publicPackageBoundaryFiles(repositoryRoot));
  });

  it("keeps repository production imports outside the Enterprise Edition path", () => {
    assertNoForbiddenEnterpriseImports(
      repositoryProductionSourceFiles(repositoryRoot),
    );
  });

  it("fails when a fixture imports an Enterprise Edition path", () => {
    expect(readFileSync(forbiddenImportFixture, "utf8")).toContain(
      "@mastra/core/ee/auth",
    );
    expect(() =>
      assertNoForbiddenEnterpriseImports([forbiddenImportFixture]),
    ).toThrow("Mastra Enterprise Edition import is forbidden");
  });

  it.each(forbiddenSyntaxFixtures)(
    "fails for every supported Enterprise Edition import syntax: %s",
    (fixture) => {
      expect(readFileSync(fixture, "utf8")).toContain("@mastra/core/ee/auth");
      expect(() => assertNoForbiddenEnterpriseImports([fixture])).toThrow(
        "Mastra Enterprise Edition import is forbidden",
      );
    },
  );

  it("records the installed Community package license and workflow export evidence", () => {
    const packageManifest = readFileSync(
      fileURLToPath(
        new URL(
          "../../../../../libs/seqlane-runtime/node_modules/@mastra/core/package.json",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    const runtimeManifest = readFileSync(
      fileURLToPath(
        new URL(
          "../../../../../libs/seqlane-runtime/package.json",
          import.meta.url,
        ),
      ),
      "utf8",
    );

    expect(packageManifest).toContain('"license": "Apache-2.0"');
    expect(packageManifest).toContain('"version": "1.64.0"');
    expect(runtimeManifest.match(/"@mastra\/[^"]+"/g)).toEqual([
      '"@mastra/core"',
    ]);
    expect(runtimeManifest).toContain('"@mastra/core": "1.64.0"');
  });
});
