// @test-scope ./review-scope-contracts.ts
// @test-scope ./review-evidence-batches.ts
// @test-scope ./review-git-fixture.test-support.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { collectReviewScopeEvidence } from "./review-scope-evidence.js";
import { createReviewGitFixture } from "./review-git-fixture.test-support.js";
import { reviewScopeEvidenceSchema } from "./review-scope-contracts.js";
import type { ReviewGitRequest } from "./review-git-budget.js";

const fixtures: Awaited<ReturnType<typeof createReviewGitFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

async function fixtureWithBase(objectFormat: "sha1" | "sha256" = "sha1") {
  const fixture = await createReviewGitFixture(objectFormat);
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
    it.each(["sha1", "sha256"] as const)(
      "accepts exact %s IDs for base, head, and checkpoint",
      async (objectFormat) => {
        const { fixture, baseRevision } = await fixtureWithBase(objectFormat);
        await fixture.write("edited.ts", "first\n");
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
        expect(result.scopeIdentity).toEqual(identity);
        expect(result.reviewablePaths).toEqual(["edited.ts"]);
        expect(result.batches[0]?.patch).toContain("-first\n+second");
      },
    );

    it.each(["base", "head", "checkpoint"])(
      "rejects a 40-character SHA-256 %s prefix before diff or fetch",
      async (role) => {
        const { fixture, baseRevision } = await fixtureWithBase("sha256");
        await fixture.write("edited.ts", "first\n");
        const checkpointRevision = await fixture.commit();
        await fixture.write("edited.ts", "second\n");
        const headRevision = await fixture.commit();
        const fetchExactCommit = vi.fn(async () => {
          throw new Error("Unexpected fetch");
        });
        await expect(
          collectReviewScopeEvidence(
            {
              ...admission(
                role === "base" ? baseRevision.slice(0, 40) : baseRevision,
                role === "head" ? headRevision.slice(0, 40) : headRevision,
              ),
              mode: "incremental",
              checkpointRevision:
                role === "checkpoint"
                  ? checkpointRevision.slice(0, 40)
                  : checkpointRevision,
              reportId: "42",
            },
            {
              git: { ...fixture.git, fetchExactCommit },
              admittedAt: performance.now(),
            },
          ),
        ).rejects.toMatchObject({ code: "COMMIT_REQUIRED" });
        expect(fetchExactCommit).not.toHaveBeenCalled();
        expect(fixture.commands.some(({ argv }) => argv.includes("diff"))).toBe(
          false,
        );
      },
    );

    it("rejects a wrong-format SHA-1 checkpoint before attempting a fetch", async () => {
      const { fixture, baseRevision } = await fixtureWithBase();
      const fetchExactCommit = vi.fn(async () => {
        throw new Error("Unexpected fetch");
      });
      await expect(
        collectReviewScopeEvidence(
          {
            ...admission(baseRevision, baseRevision),
            mode: "incremental",
            checkpointRevision: "a".repeat(64),
            reportId: "42",
          },
          {
            git: { ...fixture.git, fetchExactCommit },
            admittedAt: performance.now(),
          },
        ),
      ).rejects.toMatchObject({ code: "COMMIT_REQUIRED" });
      expect(fetchExactCommit).not.toHaveBeenCalled();
      expect(fixture.commands.some(({ argv }) => argv.includes("diff"))).toBe(
        false,
      );
    });

    it("rejects a resolved commit ID that differs from the admitted full ID", async () => {
      const { fixture, baseRevision } = await fixtureWithBase();
      await fixture.write("edited.ts", "new\n");
      const headRevision = await fixture.commit();
      const run = vi.fn(async (request: ReviewGitRequest) => {
        if (
          request.argv.includes("--end-of-options") &&
          request.argv.at(-1) === baseRevision
        ) {
          return {
            exitCode: 0,
            stdout: Buffer.from(`${headRevision}\n`),
            stderr: Buffer.alloc(0),
            stdoutTruncated: false,
            stderrTruncated: false,
            usage: {
              wallMs: 1,
            },
          };
        }
        return fixture.git.run(request);
      });
      await expect(
        collectReviewScopeEvidence(admission(baseRevision, headRevision), {
          git: { run },
          admittedAt: performance.now(),
        }),
      ).rejects.toMatchObject({ code: "COMMIT_REQUIRED" });
      expect(
        run.mock.calls.some(([request]) => request.argv.includes("diff")),
      ).toBe(false);
    });

    it("collects a baseline with literal hostile paths and explicit exclusions", async () => {
      const { fixture, baseRevision } = await fixtureWithBase();
      const paths = [
        "space name.ts",
        "line\nname.ts",
        "tab\tname.ts",
        ":(glob)*.ts",
        "-flag.ts",
        "\ufeffbom.ts",
        'quote"name.ts',
        "back\\slash.ts",
        "unicodeé.ts",
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
      expect(result.validationBatches).toEqual([]);
      expect(result.hunkCount).toBe(paths.length);
      const patches = fixture.commands.filter(({ argv }) =>
        argv.includes("--patch"),
      );
      expect(patches).toHaveLength(1);
      expect(
        patches.every(
          ({ argv }) =>
            argv.includes("--literal-pathspecs") &&
            new Set(argv.slice(argv.indexOf("--") + 1)).size === paths.length &&
            paths.every((path) =>
              argv.slice(argv.indexOf("--") + 1).includes(path),
            ),
        ),
      ).toBe(true);
      expect(reviewScopeEvidenceSchema.safeParse(result).success).toBe(true);
    });

    it("reviews only checkpoint changes and keeps base comparison in local validation", async () => {
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
      expect(result.batches[0]?.patch).toContain("-first\n+second");
      expect(result.batches[0]?.patch).not.toContain("-base");
      expect(result.validationBatches[0]?.patch).toContain("-base\n+second");
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
      expect(result.validationBatches).toEqual([]);
      expect(result.treeChanges).toEqual([]);
      expect(
        fixture.commands.some(({ argv }) => argv.includes("--patch")),
      ).toBe(false);
    });

    it("omits previously reviewed hunks and files from later review input", async () => {
      const { fixture } = await fixtureWithBase();
      const original = Array.from(
        { length: 200 },
        (_, index) => `line ${index}`,
      );
      await fixture.write("edited.ts", original.join("\n") + "\n");
      const baseRevision = await fixture.commit();
      const reviewed = [...original];
      reviewed[5] = "already reviewed hunk";
      await fixture.write("edited.ts", reviewed.join("\n") + "\n");
      await fixture.write("previous-only.ts", "already reviewed file\n");
      const checkpointRevision = await fixture.commit();
      const current = [...reviewed];
      current[150] = "new change to review";
      await fixture.write("edited.ts", current.join("\n") + "\n");
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
      const reviewPatch = result.batches.map(({ patch }) => patch).join("");
      expect(result.reviewablePaths).toEqual(["edited.ts"]);
      expect(reviewPatch).toContain("+new change to review");
      expect(reviewPatch).not.toContain("already reviewed hunk");
      expect(reviewPatch).not.toContain("previous-only.ts");
      expect(result.validationBatches[0]?.patch).toContain(
        "+already reviewed hunk",
      );
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
      expect(result.batches[0]?.patch).toContain("-first\n+second");
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
          evidenceForm: "pr-patch",
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

    it("preserves both blocks for a file-to-symlink change in grouped output", async () => {
      const { fixture, baseRevision } = await fixtureWithBase();
      await fixture.run("rm", "edited.ts");
      await symlink("target", join(fixture.cwd, "edited.ts"));
      await fixture.write("new.ts", "new\n");
      await fixture.run("config", "core.quotePath", "false");
      await fixture.run("config", "diff.noprefix", "true");
      const headRevision = await fixture.commit();
      const result = await collectReviewScopeEvidence(
        admission(baseRevision, headRevision),
        { git: fixture.git, admittedAt: performance.now() },
      );
      expect(result.treeChanges).toMatchObject([
        { path: "edited.ts", status: "T" },
        { path: "new.ts", status: "A" },
      ]);
      expect(
        result.batches[0]?.patch.match(
          /^diff --git a\/edited.ts b\/edited.ts$/gm,
        ),
      ).toHaveLength(2);
      expect(result.batches[0]?.patch).toContain("+target");
      expect(result.hunkCount).toBe(3);
    });

    it("collects 200 incremental paths with two bounded patch commands", async () => {
      const { fixture, baseRevision } = await fixtureWithBase();
      const paths = Array.from(
        { length: 200 },
        (_, index) => `selected-${index.toString().padStart(3, "0")}.ts`,
      );
      await Promise.all(paths.map((path) => fixture.write(path, "first\n")));
      const checkpointRevision = await fixture.commit();
      await Promise.all(paths.map((path) => fixture.write(path, "second\n")));
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
      expect(result.reviewablePaths).toEqual(paths);
      const commands = fixture.commands.filter(({ argv }) =>
        argv.includes("--patch"),
      );
      expect(commands).toHaveLength(2);
      expect(
        commands.every(
          ({ argv }) =>
            argv.slice(argv.indexOf("--") + 1).length === paths.length,
        ),
      ).toBe(true);
      expect(result.batches.flatMap(({ paths }) => paths)).toEqual(paths);
      expect(result.validationBatches.flatMap(({ paths }) => paths)).toEqual(
        paths,
      );
      expect(result.treeChanges).toHaveLength(400);
      expect(result.hunkCount).toBe(400);
      expect(result.batches[0]?.patch).not.toContain("new file mode");
      expect(result.validationBatches[0]?.patch).toContain("new file mode");
      expect(
        reviewScopeEvidenceSchema.safeParse({
          ...result,
          validationBatches: [],
        }).success,
      ).toBe(false);
    });

    it("partitions one complete grouped diff into bounded whole-path batches", async () => {
      const { fixture, baseRevision } = await fixtureWithBase();
      await fixture.write("large-a.txt", "a".repeat(300_000) + "\n");
      await fixture.write("large-b.txt", "b".repeat(300_000) + "\n");
      const headRevision = await fixture.commit();
      const result = await collectReviewScopeEvidence(
        admission(baseRevision, headRevision),
        { git: fixture.git, admittedAt: performance.now() },
      );
      expect(result.batches).toHaveLength(2);
      expect(result.batches.map(({ paths }) => paths)).toEqual([
        ["large-a.txt"],
        ["large-b.txt"],
      ]);
      expect(result.validationBatches).toEqual([]);
      expect(
        result.batches.every(({ patchBytes }) => patchBytes <= 512_000),
      ).toBe(true);
      expect(
        fixture.commands.filter(({ argv }) => argv.includes("--patch")),
      ).toHaveLength(1);
      expect(
        reviewScopeEvidenceSchema.safeParse({
          ...result,
          validationBatches: result.batches,
        }).success,
      ).toBe(false);
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
