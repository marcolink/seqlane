import "./require-shim.js";

import * as core from "@actions/core";
import * as github from "@actions/github";

interface PostComment {
  readonly body?: string | null;
  readonly user?: { readonly login?: string | null } | null;
}

interface PostClient {
  readonly rest: {
    readonly issues: {
      getComment(request: {
        readonly owner: string;
        readonly repo: string;
        readonly comment_id: number;
      }): Promise<{ readonly data: PostComment }>;
      updateComment(request: {
        readonly owner: string;
        readonly repo: string;
        readonly comment_id: number;
        readonly body: string;
      }): Promise<unknown>;
    };
  };
}

export interface PostPorts {
  readonly getState: (name: string) => string;
  readonly getInput: (name: string) => string;
  readonly warning: (message: string) => void;
  readonly setFailed: (message: string) => void;
  readonly getOctokit: (token: string) => PostClient;
}

const defaultPostPorts: PostPorts = {
  getState: (name) => core.getState(name),
  getInput: (name) => core.getInput(name),
  warning: (message) => core.warning(message),
  setFailed: (message) => core.setFailed(message),
  getOctokit: (token) => github.getOctokit(token),
};

function cleanupFailureMessage(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "Could not remove review marker.";
  const sanitized = message
    .split("")
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .replace(
      /((?:ghp_|gho_|github_pat_|sk-|Bearer\s+)[A-Za-z0-9._-]+)/gi,
      "[REDACTED]",
    )
    .replace(
      /((?:token|api[-_]?key|password|secret)\s*[=:]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    )
    .trim();
  return `Could not remove review marker: ${(sanitized || "unknown error").slice(0, 500)}`;
}

export async function runPost(
  ports: PostPorts = defaultPostPorts,
): Promise<void> {
  const markerId = ports.getState("review-marker-id");
  if (!markerId) return;
  const token = ports.getInput("github-token");
  if (!token) return;
  const [owner, repo] = ports.getInput("repository").split("/");
  if (!owner || !repo) return;
  const runId = ports.getState("review-run-id");
  try {
    const client = ports.getOctokit(token);
    const comment = await client.rest.issues.getComment({
      owner,
      repo,
      comment_id: Number(markerId),
    });
    const body = comment.data.body ?? "";
    const author = comment.data.user?.login;
    if (author !== "github-actions" && author !== "github-actions[bot]") {
      ports.warning(
        "The review marker comment is no longer owned by the trusted bot; leaving it in place.",
      );
      return;
    }
    const marker = `<!-- seqlane-review-in-progress-run: ${runId} -->`;
    if (
      !body.includes("<!-- seqlane-review-in-progress-start -->") ||
      !body.includes(marker)
    )
      return;
    const cleaned = body.replace(
      /<!-- seqlane-review-in-progress-start -->[\s\S]*?<!-- seqlane-review-in-progress-end -->\n?/g,
      "",
    );
    await client.rest.issues.updateComment({
      owner,
      repo,
      comment_id: Number(markerId),
      body: cleaned,
    });
  } catch (error: unknown) {
    const status =
      typeof error === "object" && error !== null && "status" in error
        ? (error as { status?: unknown }).status
        : undefined;
    if (status !== 404) ports.setFailed(cleanupFailureMessage(error));
  }
}

if (process.env.NODE_ENV !== "test")
  runPost().catch((error: unknown) =>
    core.setFailed(
      error instanceof Error ? error.message : "Code review cleanup failed.",
    ),
  );
