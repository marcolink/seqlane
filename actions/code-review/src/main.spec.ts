// @test-scope ./main.ts
import { describe, expect, it } from "vitest";
import { createIssueCommentMethods, type GitHubClient } from "./main.js";

function createClient(
  calls: {
    readonly get: unknown[];
    readonly create: unknown[];
    readonly update: unknown[];
  },
  etag = '"v1"',
): GitHubClient {
  return {
    rest: {
      issues: {
        getComment: async (request: unknown) => {
          calls.get.push(request);
          return {
            data: { id: 1, body: "report" },
            headers: { etag },
          };
        },
        createComment: async (request: unknown) => {
          calls.create.push(request);
          return { data: { id: 2 } };
        },
        updateComment: async (request: unknown) => {
          calls.update.push(request);
          return { data: { id: 1 } };
        },
        deleteComment: async () => ({ data: {} }),
      },
    },
  } as unknown as GitHubClient;
}

describe("code-review GitHub adapter", () => {
  it("retains ETags and sends conditional comment mutations", async () => {
    const calls: { get: unknown[]; create: unknown[]; update: unknown[] } = {
      get: [],
      create: [],
      update: [],
    };
    const methods = createIssueCommentMethods(
      createClient(calls),
      "owner",
      "repo",
    );

    await expect(methods.getIssueCommentWithVersion("1")).resolves.toEqual({
      data: { id: 1, body: "report" },
      etag: '"v1"',
    });
    await methods.createIssueCommentIfAbsent(83, "new report");
    await methods.updateIssueCommentIfUnchanged("1", "updated", '"v1"');

    expect(calls.create).toEqual([
      {
        owner: "owner",
        repo: "repo",
        issue_number: 83,
        body: "new report",
        headers: { "If-None-Match": "*" },
      },
    ]);
    expect(calls.update).toEqual([
      {
        owner: "owner",
        repo: "repo",
        comment_id: 1,
        body: "updated",
        headers: { "If-Match": '"v1"' },
      },
    ]);
  });

  it("reports a versioned read without a strong ETag as unavailable", async () => {
    const client = createClient(
      { get: [], create: [], update: [] },
      'W/"weak"',
    );
    const methods = createIssueCommentMethods(client, "owner", "repo");

    await expect(methods.getIssueCommentWithVersion("1")).resolves.toEqual({
      data: { id: 1, body: "report" },
      etag: undefined,
    });
  });
});
