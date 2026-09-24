// @test-scope ./github-port.ts
import { describe, expect, it } from "vitest";
import {
  findAuthoritativeReport,
  GitHubReviewAdapter,
  readNewestComments,
  type CommentSource,
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

  it("continues a stream when its next page can outrank the merged boundary", async () => {
    const requests: string[] = [];
    const source = (
      kind: "issue" | "review",
      pages: Record<number, { items: unknown[]; hasNextPage: boolean }>,
    ): CommentSource => ({
      kind,
      fetchPage: async (page) => {
        requests.push(`${kind}:${page}`);
        return pages[page] ?? { items: [], hasNextPage: false };
      },
      values: new Map(),
      page: 1,
      hasNextPage: true,
    });

    const history = await readNewestComments(
      [
        source("issue", {
          1: {
            items: [
              { id: "i-10", created_at: "2026-09-10T00:10:00Z" },
              { id: "i-09", created_at: "2026-09-10T00:09:00Z" },
            ],
            hasNextPage: true,
          },
          2: {
            items: [{ id: "i-08", created_at: "2026-09-10T00:08:30Z" }],
            hasNextPage: false,
          },
        }),
        source("review", {
          1: {
            items: [
              { id: "r-08", created_at: "2026-09-10T00:08:00Z" },
              { id: "r-07", created_at: "2026-09-10T00:07:00Z" },
            ],
            hasNextPage: true,
          },
          2: { items: [], hasNextPage: false },
        }),
      ],
      3,
    );

    expect(requests).toEqual(["issue:1", "review:1", "issue:2"]);
    expect(
      history.values.map(([value]) => (value as { id: string }).id),
    ).toEqual(["i-10", "i-09", "i-08"]);
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

  it("treats former command text as ordinary comment context", async () => {
    const client: GitHubReviewClient = {
      getPullRequest: async () => ({}),
      listIssueComments: async () => [
        {
          id: 1,
          user: { login: "octo" },
          body: "/seqlane fixed F-1 reason: already covered by the new guard",
          author_association: "OWNER",
          created_at: "2026-09-09T00:00:00Z",
        },
      ],
      getIssueComment: async () => ({}),
      createIssueComment: async () => ({}),
      updateIssueComment: async () => ({}),
      deleteIssueComment: async () => ({}),
    };

    const history = await new GitHubReviewAdapter(client).readComments(1);

    expect(history.comments[0]?.body).toBe(
      "/seqlane fixed F-1 reason: already covered by the new guard",
    );
    expect(history.comments[0]).not.toHaveProperty(
      "omittedDispositionCommands",
    );
  });

  it("returns the created marker comment ID", async () => {
    const client: GitHubReviewClient = {
      getPullRequest: async () => ({}),
      listIssueComments: async () => [],
      getIssueComment: async () => ({}),
      createIssueComment: async () => ({ id: 42 }),
      updateIssueComment: async () => ({}),
      deleteIssueComment: async () => ({}),
    };

    await expect(
      new GitHubReviewAdapter(client).createMarker(1, "marker"),
    ).resolves.toBe("42");
  });
});
