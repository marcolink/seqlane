// @test-scope ./index.ts
// @test-scope ./runner-protocol.ts
// @test-scope ./contracts.ts

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));

function source(relativePath: string): string {
  return readFileSync(`${root}/${relativePath}`, "utf8");
}

function expectNoBoundaryLeak(
  paths: readonly string[],
  patterns: readonly RegExp[],
): void {
  for (const path of paths) {
    const contents = source(path);
    for (const pattern of patterns) {
      expect(contents, `${path} matches ${pattern}`).not.toMatch(pattern);
    }
  }
}

describe("adr.executor-neutral-workflow-authoring executor-neutral boundaries", () => {
  it("keeps core and public runner protocol free of adapter details", () => {
    expectNoBoundaryLeak(
      [
        "libs/seqlane-core/src/index.ts",
        "libs/seqlane-core/src/runner-protocol.ts",
        "libs/seqlane-core/src/contracts.ts",
        "apps/seqlane-cli/src/commands/run.ts",
      ],
      [
        /OpenCodeConnection/,
        /opencode-url/,
        /createRunnerExecution/,
        /structuredOutput/,
      ],
    );
  });

  it("keeps workflow fixtures generic", () => {
    expectNoBoundaryLeak(
      [
        "libs/seqlane-fixtures/src/renovate-workflow.ts",
        "libs/seqlane-fixtures/src/renovate-fake-workflow.ts",
        "libs/seqlane-fixtures/src/mixed-workflow.ts",
        "libs/seqlane-fixtures/package.json",
      ],
      [
        /@seqlane\/opencode/,
        /OpenCodeConnection/,
        /createRunnerExecution/,
        /executor\s*:/,
      ],
    );
  });

  it("keeps supported authoring and CLI docs generic", () => {
    expectNoBoundaryLeak(
      [
        "libs/seqlane-core/README.md",
        "libs/seqlane-runtime/README.md",
        "libs/seqlane-opencode/README.md",
        "docs/sdlc/specs/2026-09-02-seqlane-plan-ir-typed-dataflow.md",
        "docs/sdlc/specs/2026-09-02-opencode-executor-integration.md",
        "docs/sdlc/adrs/2026-09-02-repository-user-workflow-discovery-and-composition.md",
        "docs/sdlc/prd/2026-09-02-seqlane.md",
      ],
      [/opencode\.task/, /opencode-url/, /createRunnerExecution/],
    );
  });

  it("does not expose workflow-authoring factories from the private adapter root", () => {
    expectNoBoundaryLeak(
      ["libs/seqlane-opencode/src/index.ts"],
      [
        /opencode\.task/,
        /structuredOutput/,
        /OpenCodeTaskDefinition/,
        /OpenCodeConnection/,
        /createOpenCodeRunnerExecution/,
      ],
    );
  });
});

describe("adr.consumer-agnostic-seqlane-execution-events execution-event boundaries", () => {
  it("does not expose the legacy RunnerEvent contract from core", () => {
    const coreIndex = source("libs/seqlane-core/src/index.ts");
    const runnerProtocol = source("libs/seqlane-core/src/runner-protocol.ts");

    for (const contents of [coreIndex, runnerProtocol]) {
      expect(contents).not.toMatch(/\bRunnerEvent\b/);
      expect(contents).not.toMatch(
        /\b(?:is|encode|decode)Runner(?:Event|Message)\b/,
      );
    }
  });
});
