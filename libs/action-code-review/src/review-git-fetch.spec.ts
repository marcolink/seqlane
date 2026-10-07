// @test-scope ./review-git-adapter.ts
// @test-scope ./review-scope-admission.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createReviewGitFixture } from "./review-git-fixture.test-support.js";
import { createReviewGitRemote } from "./review-git-remote.test-support.js";
import { admitReviewScope } from "./review-scope-admission.js";
import { createReviewGitAdapter } from "./review-git-adapter.js";
import { createReviewStateFixture } from "./review-state-fixture.test-support.js";
import { encodeReviewStateV5 } from "./review-state-codec.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, mkdtemp: vi.fn(original.mkdtemp) };
});

afterEach(async () => {
  const created = vi.mocked(mkdtemp);
  for (const [index, [prefix]] of created.mock.calls.entries()) {
    if (!String(prefix).includes("seqlane-review-fetch-")) continue;
    const result = created.mock.results[index];
    if (result?.type === "return")
      await expect(access(await result.value)).rejects.toMatchObject({
        code: "ENOENT",
      });
  }
  created.mockClear();
});

describe("native exact-checkpoint fetch", { timeout: 20_000 }, () => {
  it.each(["sha1", "sha256"] as const)(
    "fetches a missing non-ancestor %s checkpoint without moving the checkout",
    async (format) => {
      const fixture = await createReviewGitFixture(format);
      let remote: Awaited<ReturnType<typeof createReviewGitRemote>> | undefined;
      try {
        await fixture.write("first.ts", "export const value = 1;\n");
        const baseRevision = await fixture.commit();
        await fixture.write("first.ts", "export const value = 2;\n");
        await fixture.commit();
        const checkpointTree = await fixture.run("rev-parse", "HEAD^{tree}");
        await fixture.write("first.ts", "export const value = 3;\n");
        const headRevision = await fixture.commit();
        const index = await readFile(join(fixture.cwd, ".git", "index"));
        remote = await createReviewGitRemote(fixture.cwd);
        await remote.run("config", "user.name", "Fixture");
        await remote.run("config", "user.email", "review@example.test");
        const checkpoint = await remote.run(
          "commit-tree",
          checkpointTree,
          "-p",
          baseRevision,
          "-m",
          "Published checkpoint",
        );
        await remote.run("update-ref", "refs/heads/published", checkpoint);
        // Neither target URL rewrites nor executable credential helpers may affect fetch.
        await fixture.run(
          "config",
          "url.https://example.invalid/.insteadOf",
          remote.url,
        );
        await fixture.run("config", "credential.helper", "!exit 99");
        vi.stubEnv("GIT_SSL_CAINFO", remote.certificate);
        const options = {
          reviewTarget: fixture.cwd,
          trustedRemote: {
            url: remote.url,
            authorization: "Bearer fixture-secret",
          },
        };
        const body = encodeReviewStateV5(
          createReviewStateFixture(baseRevision, checkpoint),
        );
        const authority = () => ({
          listIssueComments: async () => ({
            items: [
              {
                id: 42,
                user: { login: "github-actions[bot]" },
                author_association: "NONE",
                body,
                created_at: "2026-10-07",
                updated_at: "2026-10-07",
              },
            ],
            hasNextPage: false,
          }),
        });
        const admission = await admitReviewScope(
          {
            pullRequest: {
              repositoryId: "1",
              pullRequestNumber: 112,
              targetBranch: "release",
              baseRevision,
              headRevision,
            },
          },
          { git: createReviewGitAdapter(options), authority: authority() },
        );
        expect(admission.scopeIdentity).toMatchObject({
          mode: "incremental",
          checkpointRevision: checkpoint,
        });
        expect(admission.evidence.batches[0]?.patch).toContain(
          "-export const value = 2;",
        );
        expect(admission.evidence.batches[0]?.patch).toContain(
          "+export const value = 3;",
        );
        expect(remote.authorization).toContain("Bearer fixture-secret");
        expect(await fixture.run("rev-parse", "HEAD")).toBe(headRevision);
        expect(await readFile(join(fixture.cwd, ".git", "index"))).toEqual(
          index,
        );
        expect(await readFile(join(fixture.cwd, "first.ts"), "utf8")).toBe(
          "export const value = 3;\n",
        );
        const git = createReviewGitAdapter(options);
        const fetched = await git.fetchExactCommit?.(
          "f".repeat(checkpoint.length),
          {
            argv: ["--no-replace-objects"],
            limits: { wallMs: 3000, outputBytes: 100_000 },
          },
        );
        expect(fetched).toMatchObject({ exitCode: 128 });
        await expect(
          git.fetchExactCommit?.(checkpoint, {
            argv: ["--no-replace-objects"],
            limits: { wallMs: 3000, outputBytes: 100_000 },
            signal: AbortSignal.abort("stopped"),
          }),
        ).rejects.toMatchObject({ code: "REVIEW_SCOPE_CANCELLED" });
      } finally {
        vi.unstubAllEnvs();
        await remote?.dispose();
        await fixture.dispose();
      }
    },
  );
});
