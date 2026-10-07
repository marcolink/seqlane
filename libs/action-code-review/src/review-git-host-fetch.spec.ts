// @test-scope ./review-git-host.ts
// @test-scope ./review-git-host-admission.ts
import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createReviewGitFixture } from "./review-git-fixture.test-support.js";
import { createReviewGitRemote } from "./review-git-remote.test-support.js";
import { admitReviewScopeWithGitHost } from "./review-git-host-admission.js";
import { createReviewGitHost } from "./review-git-host.js";
import { createReviewStateFixture } from "./review-state-fixture.test-support.js";
import { encodeReviewStateV5 } from "./review-state-codec.js";

describe("native exact-checkpoint fetch", { timeout: 20_000 }, () => {
  it.each(["sha1", "sha256"] as const)(
    "fetches a missing non-ancestor %s checkpoint without moving the checkout",
    async (format) => {
      const fixture = await createReviewGitFixture(format);
      let remote: Awaited<ReturnType<typeof createReviewGitRemote>> | undefined;
      let host: Awaited<ReturnType<typeof createReviewGitHost>> | undefined;
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
        const admission = await admitReviewScopeWithGitHost(
          {
            pullRequest: {
              repositoryId: "1",
              pullRequestNumber: 112,
              targetBranch: "release",
              baseRevision,
              headRevision,
            },
          },
          options,
          authority,
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
        host = await createReviewGitHost(options);
        const fetched = await host.git.fetchExactCommit?.(
          "f".repeat(checkpoint.length),
          {
            argv: ["--no-replace-objects"],
            limits: { wallMs: 3000, outputBytes: 100_000 },
          },
        );
        expect(fetched).toMatchObject({ exitCode: 128 });
      } finally {
        vi.unstubAllEnvs();
        await host?.close();
        await remote?.dispose();
        await fixture.dispose();
      }
    },
  );
});
