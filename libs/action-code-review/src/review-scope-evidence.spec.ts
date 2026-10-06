// @test-scope ./review-scope-contracts.ts
// @test-scope ./review-git-fixture.test-support.ts
import { afterEach, describe, expect, it } from "vitest";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { collectReviewScopeEvidence } from "./review-scope-evidence.js";
import { createReviewGitFixture } from "./review-git-fixture.test-support.js";
import { reviewScopeEvidenceSchema } from "./review-scope-contracts.js";

const fixtures: Awaited<ReturnType<typeof createReviewGitFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

async function fixtureWithBase() {
  const fixture = await createReviewGitFixture();
  fixtures.push(fixture);
  await fixture.write("edited.ts", "base\n");
  await fixture.write("unchanged.ts", "base\n");
  const baseRevision = await fixture.commit();
  return { fixture, baseRevision };
}

function admission(baseRevision: string, headRevision: string) {
  return {
    pullRequestNumber: 112,
    targetBranch: "release",
    baseRevision,
    headRevision,
    mode: "new-baseline",
  };
}

// Real process fixtures need room for process startup on busy CI hosts.
describe(
  "complete review scope evidence with real Git",
  { timeout: 20_000 },
  () => {
    it("collects a baseline with literal hostile paths and explicit exclusions", async () => {
      const { fixture, baseRevision } = await fixtureWithBase();
      const paths = [
        "space name.ts",
        "line\nname.ts",
        "tab\tname.ts",
        ":(glob)*.ts",
        "-flag.ts",
        "\ufeffbom.ts",
      ];
      for (const path of paths) await fixture.write(path, "new\n");
      await fixture.write("nested/dist/built.js", "excluded\n");
      await fixture.write("pnpm-lock.yaml", "excluded\n");
      const headRevision = await fixture.commit();
      const result = await collectReviewScopeEvidence(
        admission(baseRevision, headRevision),
        { git: fixture.git, admittedAt: performance.now() },
      );
      expect(new Set(result.reviewablePaths)).toEqual(new Set(paths));
      expect(result.excludedPaths).toEqual([
        "nested/dist/built.js",
        "pnpm-lock.yaml",
      ]);
      expect(result.batches).toHaveLength(1);
      expect(result.batches[0]?.changeEvidence).toBe("");
      expect(result.hunkCount).toBe(paths.length);
      const patches = fixture.commands.filter(({ argv }) =>
        argv.includes("--patch"),
      );
      expect(patches).toHaveLength(paths.length);
      expect(
        patches.every(
          ({ argv }) =>
            argv.includes("--literal-pathspecs") &&
            paths.includes(argv.at(-1)!),
        ),
      ).toBe(true);
      expect(reviewScopeEvidenceSchema.safeParse(result).success).toBe(true);
    });

    it("selects only checkpoint changes and keeps older PR edits as context", async () => {
      const { fixture, baseRevision } = await fixtureWithBase();
      await fixture.write("edited.ts", "first\n");
      await fixture.write("unchanged.ts", "first\n");
      const checkpointRevision = await fixture.commit();
      await fixture.write("edited.ts", "second\n");
      const headRevision = await fixture.commit();
      const identity = {
        ...admission(baseRevision, headRevision),
        mode: "incremental",
        checkpointRevision,
        reportId: "42",
      };
      const result = await collectReviewScopeEvidence(identity, {
        git: fixture.git,
        admittedAt: performance.now(),
      });
      expect(result.reviewablePaths).toEqual(["edited.ts"]);
      expect(result.batches[0]?.scopeIdentity).toEqual(identity);
      expect(result.batches[0]?.patch).toContain("-base\n+second");
      expect(result.batches[0]?.changeEvidence).toContain("-first\n+second");
      expect(result.hunkCount).toBe(2);
    });

    it("skips every scoped diff for a same-head admission", async () => {
      const { fixture, baseRevision } = await fixtureWithBase();
      await fixture.write("edited.ts", "first\n");
      const headRevision = await fixture.commit();
      const result = await collectReviewScopeEvidence(
        {
          ...admission(baseRevision, headRevision),
          mode: "no-change",
          checkpointRevision: headRevision,
          reportId: "42",
        },
        { git: fixture.git, admittedAt: performance.now() },
      );
      expect(result.reviewablePaths).toEqual([]);
      expect(result.batches).toEqual([]);
      expect(
        fixture.commands.some(({ argv }) => argv.includes("--patch")),
      ).toBe(false);
    });

    it("skips scoped diffs for an excluded-only baseline", async () => {
      const { fixture, baseRevision } = await fixtureWithBase();
      await fixture.write("dist/output.js", "built\n");
      const headRevision = await fixture.commit();
      const result = await collectReviewScopeEvidence(
        admission(baseRevision, headRevision),
        { git: fixture.git, admittedAt: performance.now() },
      );
      expect(result.excludedPaths).toEqual(["dist/output.js"]);
      expect(result.batches).toEqual([]);
      expect(
        fixture.commands.some(({ argv }) => argv.includes("--patch")),
      ).toBe(false);
    });

    it("handles a non-ancestor checkpoint and omits imported target changes", async () => {
      const { fixture, baseRevision: originalBase } = await fixtureWithBase();
      await fixture.write("edited.ts", "first\n");
      const checkpointRevision = await fixture.commit();
      await fixture.run("checkout", "--detach", originalBase);
      await fixture.write("target-only.ts", "target\n");
      const baseRevision = await fixture.commit();
      await fixture.write("edited.ts", "second\n");
      const headRevision = await fixture.commit();
      const result = await collectReviewScopeEvidence(
        {
          ...admission(baseRevision, headRevision),
          mode: "incremental",
          checkpointRevision,
          reportId: "42",
        },
        { git: fixture.git, admittedAt: performance.now() },
      );
      expect(result.reviewablePaths).toEqual(["edited.ts"]);
      expect(result.batches[0]?.changeEvidence).toContain("-first\n+second");
      expect(result.batches[0]?.patch).not.toContain("target-only.ts");
    });

    it("does not select a reverted tree entry or an unchanged head after base movement", async () => {
      const { fixture, baseRevision } = await fixtureWithBase();
      await fixture.write("edited.ts", "first\n");
      const checkpointRevision = await fixture.commit();
      await fixture.write("edited.ts", "temporary\n");
      await fixture.commit();
      await fixture.write("edited.ts", "first\n");
      const headRevision = await fixture.commit();
      await fixture.run("checkout", "--detach", baseRevision);
      await fixture.write("target-only.ts", "target\n");
      const movedBase = await fixture.commit();
      await fixture.run("checkout", "--detach", headRevision);
      const result = await collectReviewScopeEvidence(
        {
          ...admission(movedBase, headRevision),
          mode: "no-change",
          checkpointRevision,
          reportId: "42",
        },
        { git: fixture.git, admittedAt: performance.now() },
      );
      expect(result.reviewablePaths).toEqual([]);
      expect(result.batches).toEqual([]);
    });

    it("represents a rename as deletion plus addition and preserves binary changes", async () => {
      const { fixture, baseRevision } = await fixtureWithBase();
      await fixture.run("mv", "edited.ts", "renamed.ts");
      await fixture.write("binary.bin", Buffer.from([0, 255, 1]));
      const headRevision = await fixture.commit();
      const result = await collectReviewScopeEvidence(
        admission(baseRevision, headRevision),
        { git: fixture.git, admittedAt: performance.now() },
      );
      expect(result.reviewablePaths).toEqual([
        "binary.bin",
        "edited.ts",
        "renamed.ts",
      ]);
      expect(result.batches[0]?.patch).toContain("GIT binary patch");
      expect(result.batches[0]?.patch).toContain("deleted file mode");
      expect(result.hunkCount).toBe(2);
    });

    it("collects a mode-only change with no text hunk", async () => {
      const { fixture, baseRevision } = await fixtureWithBase();
      await fixture.run("update-index", "--chmod=+x", "edited.ts");
      await fixture.run(
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "-qm",
        "Mode change",
      );
      const headRevision = await fixture.run("rev-parse", "HEAD");
      const result = await collectReviewScopeEvidence(
        admission(baseRevision, headRevision),
        { git: fixture.git, admittedAt: performance.now() },
      );
      expect(result.reviewablePaths).toEqual(["edited.ts"]);
      expect(result.hunkCount).toBe(0);
      expect(result.batches[0]?.patch).toContain("new mode 100755");
      expect(result.treeChanges).toMatchObject([
        {
          path: "edited.ts",
          oldMode: "100644",
          newMode: "100755",
          evidenceForm: "review-patch",
        },
      ]);
    });

    it("records a symlink target without traversing the target", async () => {
      const { fixture, baseRevision } = await fixtureWithBase();
      await symlink("/outside/review-workspace", join(fixture.cwd, "link"));
      const headRevision = await fixture.commit();
      const result = await collectReviewScopeEvidence(
        admission(baseRevision, headRevision),
        { git: fixture.git, admittedAt: performance.now() },
      );
      expect(result.reviewablePaths).toEqual(["link"]);
      expect(result.treeChanges[0]).toMatchObject({
        path: "link",
        newMode: "120000",
        status: "A",
      });
      expect(result.batches[0]?.patch).toContain("+/outside/review-workspace");
    });

    it("records a submodule tree entry without executing submodule code", async () => {
      const { fixture, baseRevision } = await fixtureWithBase();
      await fixture.run(
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${baseRevision},submodule`,
      );
      await fixture.run(
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "-qm",
        "Submodule entry",
      );
      const headRevision = await fixture.run("rev-parse", "HEAD");
      const result = await collectReviewScopeEvidence(
        admission(baseRevision, headRevision),
        { git: fixture.git, admittedAt: performance.now() },
      );
      expect(result.reviewablePaths).toEqual(["submodule"]);
      expect(result.treeChanges[0]).toMatchObject({
        path: "submodule",
        newMode: "160000",
        newObjectId: baseRevision,
      });
    });

    it("rejects a tree object as checkpoint without attempting to peel or fetch it", async () => {
      const { fixture, baseRevision } = await fixtureWithBase();
      const checkpointRevision = await fixture.run("rev-parse", "HEAD^{tree}");
      await expect(
        collectReviewScopeEvidence(
          {
            ...admission(baseRevision, baseRevision),
            mode: "incremental",
            checkpointRevision,
            reportId: "42",
          },
          { git: fixture.git, admittedAt: performance.now() },
        ),
      ).rejects.toMatchObject({ code: "COMMIT_REQUIRED" });
    });

    it("fails closed for an unavailable checkpoint or stale checkout", async () => {
      const { fixture, baseRevision } = await fixtureWithBase();
      await expect(
        collectReviewScopeEvidence(
          {
            ...admission(baseRevision, baseRevision),
            mode: "incremental",
            checkpointRevision: "a".repeat(40),
            reportId: "42",
          },
          { git: fixture.git, admittedAt: performance.now() },
        ),
      ).rejects.toMatchObject({ code: "CHECKPOINT_UNAVAILABLE" });
      await fixture.write("edited.ts", "new\n");
      const headRevision = await fixture.commit();
      await fixture.run("checkout", "--detach", baseRevision);
      await expect(
        collectReviewScopeEvidence(admission(baseRevision, headRevision), {
          git: fixture.git,
          admittedAt: performance.now(),
        }),
      ).rejects.toMatchObject({ code: "HEAD_MISMATCH" });
    });

    it("rejects an oversized path instead of truncating its evidence", async () => {
      const { fixture, baseRevision } = await fixtureWithBase();
      await fixture.write("large.txt", "a".repeat(512_000) + "\n");
      const headRevision = await fixture.commit();
      await expect(
        collectReviewScopeEvidence(admission(baseRevision, headRevision), {
          git: fixture.git,
          admittedAt: performance.now(),
        }),
      ).rejects.toMatchObject({
        code: "REVIEW_SCOPE_LIMIT",
        resource: "batchBytes",
      });
    });

    it("rejects altered or missing batch and tree evidence", async () => {
      const { fixture, baseRevision } = await fixtureWithBase();
      await fixture.write("edited.ts", "first\n");
      const headRevision = await fixture.commit();
      const result = await collectReviewScopeEvidence(
        admission(baseRevision, headRevision),
        { git: fixture.git, admittedAt: performance.now() },
      );
      expect(
        reviewScopeEvidenceSchema.safeParse({ ...result, batches: [] }).success,
      ).toBe(false);
      expect(
        reviewScopeEvidenceSchema.safeParse({ ...result, treeChanges: [] })
          .success,
      ).toBe(false);
      expect(
        reviewScopeEvidenceSchema.safeParse({
          ...result,
          treeChanges: [...result.treeChanges, ...result.treeChanges],
        }).success,
      ).toBe(false);
      expect(
        reviewScopeEvidenceSchema.safeParse({
          ...result,
          evidenceBytes: result.evidenceBytes + 1,
        }).success,
      ).toBe(false);
      const batch = result.batches[0];
      expect(
        reviewScopeEvidenceSchema.safeParse({
          ...result,
          batches: [{ ...batch, ordinal: 2 }],
        }).success,
      ).toBe(false);
      expect(
        reviewScopeEvidenceSchema.safeParse({
          ...result,
          batches: [
            {
              ...batch,
              scopeIdentity: {
                ...result.scopeIdentity,
                headRevision: baseRevision,
              },
            },
          ],
        }).success,
      ).toBe(false);
    });
  },
);
