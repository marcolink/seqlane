// @test-scope ./main.ts
import { describe, expect, it } from "vitest";
import {
  appendPublicationSummary,
  createIssueCommentMethods,
  type GitHubClient,
} from "./main.js";

function createClient(calls: {
  readonly get: unknown[];
  readonly create: unknown[];
  readonly update: unknown[];
}): GitHubClient {
  return {
    rest: {
      issues: {
        getComment: async (request: unknown) => {
          calls.get.push(request);
          return {
            data: { id: 1, body: "report" },
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
  it("appends the published report to the GitHub job summary", async () => {
    const written: string[] = [];
    await appendPublicationSummary("# Seqlane review\n\nRun metrics", {
      addRaw: (value) => ({
        write: async () => {
          written.push(value);
        },
      }),
    });

    expect(written).toEqual(["# Seqlane review\n\nRun metrics"]);
  });

  it("uses ordinary comment mutations behind workflow serialization", async () => {
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

    await methods.getIssueComment("1");
    await methods.createIssueComment(83, "new report");
    await methods.updateIssueComment("1", "updated");

    expect(calls.create).toEqual([
      {
        owner: "owner",
        repo: "repo",
        issue_number: 83,
        body: "new report",
      },
    ]);
    expect(calls.update).toEqual([
      {
        owner: "owner",
        repo: "repo",
        comment_id: 1,
        body: "updated",
      },
    ]);
  });

  it("does not expose ETag-dependent comment operations", () => {
    const methods = createIssueCommentMethods(
      createClient({ get: [], create: [], update: [] }),
      "owner",
      "repo",
    );

    expect(methods).not.toHaveProperty("getIssueCommentWithVersion");
    expect(methods).not.toHaveProperty("createIssueCommentIfAbsent");
    expect(methods).not.toHaveProperty("updateIssueCommentIfUnchanged");
  });
});
