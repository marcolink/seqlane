import * as core from "@actions/core";
import * as github from "@actions/github";

export async function runPost(): Promise<void> {
  const markerId = core.getState("review-marker-id");
  if (!markerId) return;
  const token = core.getInput("github-token");
  if (!token) return;
  const [owner, repo] = core.getInput("repository").split("/");
  if (!owner || !repo) return;
  const runId = core.getState("review-run-id");
  try {
    const client = github.getOctokit(token);
    const comment = await client.rest.issues.getComment({
      owner,
      repo,
      comment_id: Number(markerId),
    });
    const body = comment.data.body ?? "";
    const author = comment.data.user?.login;
    if (author !== "github-actions" && author !== "github-actions[bot]") {
      core.warning(
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
    if (status !== 404)
      core.error(
        error instanceof Error
          ? error.message
          : "Could not remove review marker.",
      );
  }
}

if (process.env.NODE_ENV !== "test")
  runPost().catch((error: unknown) =>
    core.setFailed(
      error instanceof Error ? error.message : "Code review cleanup failed.",
    ),
  );
