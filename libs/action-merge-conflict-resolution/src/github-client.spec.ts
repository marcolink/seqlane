// @test-scope ./github-client.ts
// @test-scope ./github-port.ts
// @test-scope ./policy.ts

import { describe, expect, it } from "vitest";

import { GitHubMetadataAdapter } from "./github-client.js";
import {
  workflowDefinitionMetadata,
  type GitHubMetadataClient,
} from "./github-port.js";
import { validatePullRequestPreflight } from "./policy.js";

const baseRevision = "a".repeat(40);
const headRevision = "b".repeat(40);
const liveBaseRevision = "c".repeat(40);

const repository = { owner: "org", name: "repo" } as const;

function pullRequestResponse(headRepository = repository) {
  return {
    number: 42,
    state: "open",
    base: {
      ref: "main",
      sha: baseRevision,
      repo: {
        name: repository.name,
        full_name: `${repository.owner}/${repository.name}`,
      },
    },
    head: {
      ref: "feature/conflicts",
      sha: headRevision,
      repo: {
        name: headRepository.name,
        full_name: `${headRepository.owner}/${headRepository.name}`,
      },
    },
  };
}

function clientReturning(
  pullRequest: unknown,
  branchRef: unknown = {
    ref: "refs/heads/main",
    object: { sha: liveBaseRevision },
  },
): GitHubMetadataClient {
  return {
    getPullRequest: async () => pullRequest,
    getBranchRef: async () => branchRef,
  };
}

describe("GitHub metadata adapter", () => {
  it("maps pull-request data and preserves workflow metadata", async () => {
    const calls: Array<unknown> = [];
    const client: GitHubMetadataClient = {
      getPullRequest: async (request) => {
        calls.push(request);
        return pullRequestResponse();
      },
      getBranchRef: async () => ({
        ref: "refs/heads/main",
        object: { sha: liveBaseRevision },
      }),
    };
    const adapter = new GitHubMetadataAdapter({
      client,
      repository,
      workflow: workflowDefinitionMetadata("refs/heads/main", headRevision),
    });

    await expect(adapter.readPullRequest(42)).resolves.toEqual({
      number: 42,
      state: "open",
      baseBranch: "main",
      headBranch: "feature/conflicts",
      baseRevision,
      headRevision,
      baseRepository: repository,
      headRepository: repository,
      workflowRef: "refs/heads/main",
      workflowRevision: headRevision,
    });
    expect(calls).toEqual([
      { owner: "org", repository: "repo", pullRequestNumber: 42 },
    ]);
  });

  it("keeps fork metadata for the pure same-repository preflight policy", async () => {
    const adapter = new GitHubMetadataAdapter({
      client: clientReturning(
        pullRequestResponse({ owner: "other", name: "repo" }),
      ),
      repository,
    });

    const metadata = await adapter.readPullRequest(42);
    expect(() =>
      validatePullRequestPreflight(metadata, repository),
    ).toThrowError(
      expect.objectContaining({
        category: "pull-request-preflight",
        code: "FORK_PULL_REQUEST",
      }),
    );
  });

  it("rejects malformed responses with a typed preflight error", async () => {
    const adapter = new GitHubMetadataAdapter({
      client: clientReturning({
        ...pullRequestResponse(),
        base: {
          ...pullRequestResponse().base,
          sha: "not-a-revision",
        },
      }),
      repository,
    });

    await expect(adapter.readPullRequest(42)).rejects.toMatchObject({
      category: "pull-request-preflight",
      code: "MALFORMED_PULL_REQUEST",
      cause: expect.anything(),
    });
  });

  it("reports client failures as operational errors and preserves the cause", async () => {
    const cause = new Error("request failed");
    const adapter = new GitHubMetadataAdapter({
      client: {
        getPullRequest: async () => {
          throw cause;
        },
        getBranchRef: async () => ({}),
      },
      repository,
    });

    await expect(adapter.readPullRequest(42)).rejects.toMatchObject({
      category: "operational",
      code: "OPERATION_FAILED",
      cause,
    });
  });

  it("reads the live base branch with the GitHub ref shape", async () => {
    const calls: Array<unknown> = [];
    const adapter = new GitHubMetadataAdapter({
      client: {
        getPullRequest: async () => pullRequestResponse(),
        getBranchRef: async (request) => {
          calls.push(request);
          return {
            ref: "refs/heads/main",
            object: { sha: liveBaseRevision },
          };
        },
      },
      repository,
    });

    await expect(adapter.readLiveBaseRevision("main")).resolves.toEqual({
      branch: "main",
      revision: liveBaseRevision,
    });
    expect(calls).toEqual([
      { owner: "org", repository: "repo", ref: "heads/main" },
    ]);
  });

  it("rejects a mismatched live branch response as malformed metadata", async () => {
    const adapter = new GitHubMetadataAdapter({
      client: clientReturning(pullRequestResponse(), {
        ref: "refs/heads/other",
        object: { sha: liveBaseRevision },
      }),
      repository,
    });

    await expect(adapter.readLiveBaseRevision("main")).rejects.toMatchObject({
      category: "pull-request-preflight",
      code: "MALFORMED_PULL_REQUEST",
    });
  });

  it("rejects invalid adapter inputs before making GitHub requests", async () => {
    const client: GitHubMetadataClient = {
      getPullRequest: async () => {
        throw new Error("must not be called");
      },
      getBranchRef: async () => {
        throw new Error("must not be called");
      },
    };
    const adapter = new GitHubMetadataAdapter({ client, repository });

    await expect(adapter.readPullRequest(0)).rejects.toMatchObject({
      category: "input-validation",
      code: "INVALID_REQUEST",
    });
    await expect(adapter.readLiveBaseRevision("")).rejects.toMatchObject({
      category: "pull-request-preflight",
      code: "MALFORMED_PULL_REQUEST",
    });
  });

  it("validates workflow metadata at the adapter boundary", () => {
    expect(
      () =>
        new GitHubMetadataAdapter({
          client: clientReturning(pullRequestResponse()),
          repository,
          workflow: { ref: "", sha: "bad" } as never,
        }),
    ).toThrowError(
      expect.objectContaining({
        category: "pull-request-preflight",
        code: "MALFORMED_PULL_REQUEST",
      }),
    );
  });
});
