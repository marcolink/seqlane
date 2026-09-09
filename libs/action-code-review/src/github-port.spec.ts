// @test-scope ./github-port.ts
import { describe, expect, it } from "vitest";
import {
  findAuthoritativeReport,
  GitHubReviewAdapter,
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
    const page =
      (kind: string, number: number) => async (requested: number) => {
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
      listIssueComments: page("issue", 1),
      listReviewComments: page("review", 1),
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

  it("bounds disposition commands while retaining the newest commands", async () => {
    const body = Array.from(
      { length: 250 },
      (_, index) => `/seqlane fixed F-${index + 1}`,
    ).join("\n");
    const client: GitHubReviewClient = {
      getPullRequest: async () => ({}),
      listIssueComments: async () => [
        {
          id: 1,
          user: { login: "octo" },
          body,
          author_association: "OWNER",
          created_at: "2026-09-09T00:00:00Z",
        },
      ],
      listReviewComments: async () => [],
      getIssueComment: async () => ({}),
      createIssueComment: async () => ({}),
      updateIssueComment: async () => ({}),
      deleteIssueComment: async () => ({}),
    };
    const history = await new GitHubReviewAdapter(client).readComments(1);
    const comment = history.comments[0]!;
    expect(comment.omittedDispositionCommands).toHaveLength(200);
    expect(comment.omittedDispositionCommands?.[0]?.findingId).toBe("F-51");
    expect(comment.omittedDispositionCommands?.at(-1)?.findingId).toBe("F-250");
    expect(comment.omittedDispositionCommandsTruncated).toBe(true);
  });

  it("uses a strong ETag for conditional report writes and treats a lost race as stale", async () => {
    const updates: Array<{ id: string; body: string; version: string }> = [];
    const adapter = new GitHubReviewAdapter({
      getPullRequest: async () => ({}),
      listIssueComments: async () => [],
      listReviewComments: async () => [],
      getIssueComment: async () => ({
        id: 1,
        user: { login: "github-actions[bot]" },
        body: "<!-- seqlane-code-review --> report",
        author_association: "NONE",
        created_at: "2026-09-09T00:00:00Z",
      }),
      getIssueCommentWithVersion: async () => ({
        data: {
          id: 1,
          user: { login: "github-actions[bot]" },
          body: "<!-- seqlane-code-review --> report",
          author_association: "NONE",
          created_at: "2026-09-09T00:00:00Z",
        },
        etag: '"v1"',
      }),
      createIssueComment: async () => ({}),
      updateIssueComment: async () => ({}),
      updateIssueCommentIfUnchanged: async (id, body, version) => {
        updates.push({ id, body, version });
        const error = new Error("precondition failed") as Error & {
          status: number;
        };
        error.status = 412;
        throw error;
      },
      deleteIssueComment: async () => ({}),
    });

    const current = await adapter.readIssueCommentVersioned("1");
    expect(current.version).toBe('"v1"');
    expect(
      await adapter.updateReportIfUnchanged("1", "new report", current.version),
    ).toBe("stale");
    expect(updates).toEqual([{ id: "1", body: "new report", version: '"v1"' }]);
  });
});
