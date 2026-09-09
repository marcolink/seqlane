// @test-scope ./github-port.ts
import { describe, expect, it } from "vitest";
import {
  findAuthoritativeReport,
  GitHubReviewAdapter,
  selectNewestDispositionCommands,
  type DispositionCommandCandidate,
  type GitHubReviewClient,
} from "./github-port.js";

describe("GitHubReviewAdapter", () => {
  it("finds the newest trusted report from already-read history", () => {
    const history = {
      truncated: false,
      comments: [
        {
          id: "1",
          kind: "issue" as const,
          author: "github-actions[bot]",
          authorAssociation: "NONE",
          body: "<!-- seqlane-code-review --> old",
          createdAt: "2026-09-09T00:00:00Z",
        },
        {
          id: "2",
          kind: "issue" as const,
          author: "github-actions[bot]",
          authorAssociation: "NONE",
          body: "<!-- seqlane-code-review --> new",
          createdAt: "2026-09-09T00:00:01Z",
        },
      ],
    };

    expect(findAuthoritativeReport(history)?.id).toBe("2");
  });

  it("retrieves newest-first pages only until the bounded history budget", async () => {
    const requests: Array<{ kind: string; page: number }> = [];
    const page = (kind: string) => async (requested: number) => {
      requests.push({ kind, page: requested });
      return {
        items: Array.from({ length: 100 }, (_, index) => ({
          id: `${kind}-${requested}-${index}`,
          user: { login: "octo" },
          body: "context",
          author_association: "NONE",
          created_at: `2026-09-${String(30 - requested).padStart(2, "0")}T00:${String(index).padStart(2, "0")}:00Z`,
        })),
        hasNextPage: true,
      };
    };
    const history = await new GitHubReviewAdapter({
      getPullRequest: async () => ({}),
      listIssueComments: page("issue"),
      listReviewComments: page("review"),
      getIssueComment: async () => ({}),
      createIssueComment: async () => ({}),
      updateIssueComment: async () => ({}),
      deleteIssueComment: async () => ({}),
    }).readComments(1);

    expect(requests).toEqual([
      { kind: "issue", page: 1 },
      { kind: "review", page: 1 },
    ]);
    expect(history.comments).toHaveLength(200);
    expect(history.truncated).toBe(true);
  });

  it("keeps only valid non-null line and commit metadata", async () => {
    const client: GitHubReviewClient = {
      getPullRequest: async () => ({}),
      listIssueComments: async () => [
        {
          id: 1,
          user: { login: "octo" },
          body: "context",
          author_association: "NONE",
          created_at: "2026-09-09T00:00:00Z",
          line: null,
          commit_id: null,
        },
      ],
      listReviewComments: async () => [
        {
          id: 2,
          user: { login: "octo" },
          body: "context",
          author_association: "NONE",
          created_at: "2026-09-09T00:00:01Z",
          line: "not-a-line",
          commit_id: "not-a-revision",
        },
        {
          id: 3,
          user: { login: "octo" },
          body: "context",
          author_association: "NONE",
          created_at: "2026-09-09T00:00:02Z",
          line: 12,
          commit_id: "a".repeat(40),
        },
      ],
      getIssueComment: async () => ({}),
      createIssueComment: async () => ({}),
      updateIssueComment: async () => ({}),
      deleteIssueComment: async () => ({}),
    };
    const history = await new GitHubReviewAdapter(client).readComments(1);
    expect(history.comments[0]).not.toHaveProperty("line");
    expect(history.comments[0]).not.toHaveProperty("commitId");
    expect(history.comments[1]).not.toHaveProperty("line");
    expect(history.comments[1]).not.toHaveProperty("commitId");
    expect(history.comments[2]).toMatchObject({
      line: 12,
      commitId: "a".repeat(40),
    });
  });

  it("returns the created marker comment ID", async () => {
    const client: GitHubReviewClient = {
      getPullRequest: async () => ({}),
      listIssueComments: async () => [],
      listReviewComments: async () => [],
      getIssueComment: async () => ({}),
      createIssueComment: async () => ({ id: 42 }),
      updateIssueComment: async () => ({}),
      deleteIssueComment: async () => ({}),
    };

    await expect(
      new GitHubReviewAdapter(client).createMarker(1, "marker"),
    ).resolves.toBe("42");
  });

  it("retains newest disposition commands with deterministic tie-breaking", () => {
    const candidate = (
      commentTime: string,
      commentIdentity: string,
      line: number,
      findingId: string,
    ): DispositionCommandCandidate => ({
      commentTime,
      commentIdentity,
      line,
      command: {
        findingId,
        action: "fixed",
        authorized: true,
      },
    });

    const retained = selectNewestDispositionCommands(
      [
        candidate("2026-09-09T00:00:00Z", "issue:2", 1, "F-old"),
        candidate("2026-09-09T00:00:01Z", "issue:1", 1, "F-newer"),
        candidate("2026-09-09T00:00:01Z", "issue:1", 2, "F-newest"),
      ],
      2,
    );

    expect(retained).toEqual(new Set(["issue:1:1", "issue:1:2"]));
  });
});
