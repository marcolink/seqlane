// @test-scope ./post.ts
import { describe, expect, it } from "vitest";
import { runPost, type PostPorts } from "./post.js";

function createPorts(
  getComment: PostPorts["getOctokit"],
): PostPorts & { readonly failed: string[] } {
  const failed: string[] = [];
  return {
    failed,
    getState: (name) =>
      name === "review-marker-id" ? "42" : "review-run-id-value",
    getInput: (name) =>
      name === "github-token" ? "token" : "owner/repository",
    warning: () => undefined,
    setFailed: (message) => failed.push(message),
    getOctokit: getComment,
  };
}

describe("code-review post cleanup", () => {
  it("makes non-404 cleanup failures visible as an Action failure", async () => {
    const ports = createPorts(() => ({
      rest: {
        issues: {
          getComment: async () => ({
            data: {
              body: [
                "<!-- seqlane-review-in-progress-start -->",
                "<!-- seqlane-review-in-progress-run: review-run-id-value -->",
                "<!-- seqlane-review-in-progress-end -->",
              ].join("\n"),
              user: { login: "github-actions[bot]" },
            },
          }),
          updateComment: async () => {
            throw Object.assign(new Error("GitHub update failed"), {
              status: 500,
            });
          },
        },
      },
    }));

    await runPost(ports);

    expect(ports.failed).toEqual([
      "Could not remove review marker: GitHub update failed",
    ]);
  });

  it("treats a missing marker comment as already cleaned", async () => {
    const ports = createPorts(() => ({
      rest: {
        issues: {
          getComment: async () => {
            throw Object.assign(new Error("not found"), { status: 404 });
          },
          updateComment: async () => undefined,
        },
      },
    }));

    await runPost(ports);

    expect(ports.failed).toEqual([]);
  });
});
