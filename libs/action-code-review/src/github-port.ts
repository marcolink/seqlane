import {
  gitRevisionSchema,
  pullRequestContextSchema,
  reviewCommentSchema,
  type PullRequestContext,
  type ReviewComment,
  type ReviewHistory,
} from "./contracts.js";
import { CodeReviewError } from "./errors.js";
import { z } from "zod";

export interface GitHubReviewPort {
  readPullRequest(number: number): Promise<PullRequestContext>;
  readComments(number: number): Promise<ReviewHistory>;
  readAuthoritativeReport(number: number): Promise<ReviewComment | undefined>;
  readIssueComment(commentId: string): Promise<ReviewComment>;
  createReport(number: number, body: string): Promise<void>;
  updateReport(commentId: string, body: string): Promise<void>;
  deleteComment(commentId: string): Promise<void>;
}

const TRUSTED_REPORT_AUTHORS = new Set([
  "github-actions",
  "github-actions[bot]",
]);
const AUTHORIZED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const MAX_COMMENT_BODY = 65_536;
const MAX_CONTEXT_BODY = 2_000;
const MAX_COMMENTS = 200;
const MAX_DISPOSITION_COMMANDS = 200;
const COMMAND_PATTERN =
  /^\s*\/seqlane\s+(fixed|wont-fix|downgrade)\s+((?:F-[A-Za-z0-9][A-Za-z0-9_-]{0,63}|SEQ-PR[1-9]\d*-[0-9]{3,}))(?:\s+(.*))?\s*$/i;
const commentLineSchema = z.number().int().positive();

export function findAuthoritativeReport(
  history: ReviewHistory,
): ReviewComment | undefined {
  return [...history.comments]
    .reverse()
    .find(
      (comment) =>
        (comment.author === "github-actions" ||
          comment.author === "github-actions[bot]") &&
        comment.body.includes("<!-- seqlane-code-review -->"),
    );
}

function normalizeComment(
  value: object,
  kind: "issue" | "review",
): ReviewComment {
  const source = value as Record<string, unknown>;
  const authorSource = source.user;
  const author =
    typeof authorSource === "object" && authorSource !== null
      ? String((authorSource as Record<string, unknown>).login ?? "unknown")
      : "unknown";
  const originalBody = typeof source.body === "string" ? source.body : "";
  const trusted =
    TRUSTED_REPORT_AUTHORS.has(author) &&
    originalBody.includes("<!-- seqlane-code-review -->");
  const limit = trusted ? MAX_COMMENT_BODY : MAX_CONTEXT_BODY;
  const bodyTruncated = originalBody.length > limit;
  const lines = originalBody.slice(0, MAX_COMMENT_BODY).split(/\r?\n/);
  const allCommands = lines.flatMap((line) => {
    const match = line.match(COMMAND_PATTERN);
    if (match === null) return [];
    const action = match[1]!.toLowerCase() as
      "fixed" | "wont-fix" | "downgrade";
    let effectiveSeverity:
      "critical" | "required" | "optional" | "nit" | undefined;
    if (action === "downgrade") {
      const downgradeSeverity = match[3]
        ?.trim()
        .match(
          /^(?:to\s+)?(critical|required|optional|nit)(?:\s+(?:reason\s*[:=]\s*)?(.*))?$/i,
        )?.[1];
      if (downgradeSeverity === undefined) return [];
      effectiveSeverity =
        downgradeSeverity.toLowerCase() as typeof effectiveSeverity;
    }
    return [
      {
        findingId: match[2]!,
        action,
        authorized: AUTHORIZED_ASSOCIATIONS.has(
          String(source.author_association ?? "NONE"),
        ),
        ...(effectiveSeverity === undefined ? {} : { effectiveSeverity }),
      },
    ];
  });
  const commands = allCommands.slice(-MAX_DISPOSITION_COMMANDS);
  const body = trusted
    ? originalBody.slice(0, MAX_COMMENT_BODY)
    : lines
        .filter((line) => !line.toLowerCase().includes("/seqlane"))
        .join("\n")
        .slice(0, MAX_CONTEXT_BODY) +
      (commands.length === 0
        ? ""
        : `${lines.some((line) => line.match(COMMAND_PATTERN) !== null) ? "\n" : ""}${commands.map((command) => `/seqlane ${command.action} ${command.findingId}${command.effectiveSeverity === undefined ? "" : ` ${command.effectiveSeverity}`}`).join("\n")}`);
  const line =
    source.line === null || source.line === undefined
      ? undefined
      : commentLineSchema.safeParse(source.line).data;
  const commitId =
    source.commit_id === null || source.commit_id === undefined
      ? undefined
      : gitRevisionSchema.safeParse(source.commit_id).data;
  const parsed = reviewCommentSchema.safeParse({
    id: String(source.id ?? ""),
    kind,
    author,
    authorAssociation: String(source.author_association ?? "NONE"),
    body,
    ...(bodyTruncated ? { bodyTruncated: true } : {}),
    ...(commands.length === 0 ? {} : { omittedDispositionCommands: commands }),
    ...(allCommands.length > commands.length
      ? { omittedDispositionCommandsTruncated: true }
      : {}),
    createdAt: String(source.created_at ?? ""),
    ...(source.updated_at === undefined
      ? {}
      : { updatedAt: String(source.updated_at) }),
    ...(source.path === undefined ? {} : { path: String(source.path) }),
    ...(line === undefined ? {} : { line }),
    ...(commitId === undefined ? {} : { commitId }),
    ...(source.in_reply_to_id === undefined
      ? {}
      : { inReplyTo: String(source.in_reply_to_id) }),
  });
  if (!parsed.success)
    throw githubError(
      "MALFORMED_COMMENTS",
      "GitHub returned malformed comment data.",
      parsed.error,
    );
  return parsed.data;
}

export interface GitHubReviewClient {
  getPullRequest(number: number): Promise<unknown>;
  listIssueComments(number: number, page?: number): Promise<unknown>;
  listReviewComments(number: number, page?: number): Promise<unknown>;
  getIssueComment(commentId: string): Promise<unknown>;
  createIssueComment(number: number, body: string): Promise<unknown>;
  updateIssueComment(commentId: string, body: string): Promise<unknown>;
  deleteIssueComment(commentId: string): Promise<unknown>;
}

const commentPageSchema = z.strictObject({
  items: z.array(z.unknown()),
  hasNextPage: z.boolean(),
});
type CommentPage = z.infer<typeof commentPageSchema>;

function parseCommentPage(value: unknown): CommentPage {
  if (Array.isArray(value)) return { items: value, hasNextPage: false };
  const parsed = commentPageSchema.safeParse(value);
  if (!parsed.success)
    throw githubError(
      "MALFORMED_COMMENTS",
      "GitHub returned malformed comment data.",
      parsed.error,
    );
  return parsed.data;
}

function commentTime(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  const source = value as Record<string, unknown>;
  return typeof source.updated_at === "string"
    ? source.updated_at
    : typeof source.created_at === "string"
      ? source.created_at
      : "";
}

function commentIdentity(value: unknown, kind: "issue" | "review"): string {
  if (typeof value !== "object" || value === null) return `${kind}:`;
  const id = (value as Record<string, unknown>).id;
  return `${kind}:${typeof id === "string" || typeof id === "number" ? id : ""}`;
}

interface CommentSource {
  readonly kind: "issue" | "review";
  readonly fetchPage: (page: number) => Promise<unknown>;
  readonly values: Map<string, unknown>;
  page: number;
  hasNextPage: boolean;
}

async function readNewestComments(sources: readonly CommentSource[]): Promise<{
  readonly values: ReadonlyArray<readonly [unknown, "issue" | "review"]>;
  readonly truncated: boolean;
}> {
  const readPage = async (source: CommentSource): Promise<void> => {
    const result = parseCommentPage(await source.fetchPage(source.page));
    for (const value of result.items) {
      if (typeof value === "object" && value !== null)
        source.values.set(commentIdentity(value, source.kind), value);
    }
    source.hasNextPage = result.hasNextPage;
    source.page += 1;
  };
  await Promise.all(sources.map((source) => readPage(source)));
  while (
    sources.some((source) => source.hasNextPage) &&
    sources.reduce((total, source) => total + source.values.size, 0) <
      MAX_COMMENTS
  ) {
    const source = [...sources]
      .filter((candidate) => candidate.hasNextPage)
      .sort((left, right) => {
        const leftValues = [...left.values.values()];
        const rightValues = [...right.values.values()];
        return commentTime(rightValues.at(-1)).localeCompare(
          commentTime(leftValues.at(-1)),
        );
      })[0];
    if (source === undefined) break;
    await readPage(source);
  }
  const values = new Map<string, readonly [unknown, "issue" | "review"]>();
  for (const source of sources)
    for (const [identity, value] of source.values)
      values.set(identity, [value, source.kind]);
  const ordered = [...values.values()].sort((left, right) =>
    commentTime(right[0]).localeCompare(commentTime(left[0])),
  );
  return {
    values: ordered.slice(0, MAX_COMMENTS),
    truncated:
      sources.some((source) => source.hasNextPage) ||
      ordered.length > MAX_COMMENTS,
  };
}

function githubError(
  code: string,
  message: string,
  cause?: unknown,
): CodeReviewError {
  return new CodeReviewError("github", code, message, { cause });
}

export class GitHubReviewAdapter implements GitHubReviewPort {
  constructor(private readonly client: GitHubReviewClient) {}

  async readPullRequest(number: number): Promise<PullRequestContext> {
    try {
      const value = await this.client.getPullRequest(number);
      const source =
        typeof value === "object" && value !== null
          ? (value as Record<string, unknown>)
          : {};
      const parsed = pullRequestContextSchema.safeParse({
        number: source.number,
        title: source.title ?? "",
        description: source.description ?? source.body ?? "",
      });
      if (!parsed.success)
        throw githubError(
          "MALFORMED_PULL_REQUEST",
          "GitHub returned malformed pull-request data.",
          parsed.error,
        );
      return parsed.data;
    } catch (cause) {
      if (cause instanceof CodeReviewError) throw cause;
      throw githubError(
        "PULL_REQUEST_READ_FAILED",
        "Could not read pull-request data.",
        cause,
      );
    }
  }

  async readComments(number: number): Promise<ReviewHistory> {
    try {
      const issues: CommentSource = {
        kind: "issue",
        fetchPage: (page) => this.client.listIssueComments(number, page),
        values: new Map(),
        page: 1,
        hasNextPage: true,
      };
      const reviews: CommentSource = {
        kind: "review",
        fetchPage: (page) => this.client.listReviewComments(number, page),
        values: new Map(),
        page: 1,
        hasNextPage: true,
      };
      const history = await readNewestComments([issues, reviews]);
      const values = history.values
        .filter(
          (entry): entry is readonly [object, "issue" | "review"] =>
            typeof entry[0] === "object" && entry[0] !== null,
        )
        .map(([value, kind]) => normalizeComment(value, kind));
      const latestByIdentity = new Map<string, ReviewComment>();
      for (const comment of values) {
        const key = `${comment.kind}:${comment.id}`;
        const previous = latestByIdentity.get(key);
        if (
          previous === undefined ||
          (previous.updatedAt ?? previous.createdAt) <=
            (comment.updatedAt ?? comment.createdAt)
        )
          latestByIdentity.set(key, comment);
      }
      const ordered = [...latestByIdentity.values()].sort((left, right) =>
        (left.updatedAt ?? left.createdAt).localeCompare(
          right.updatedAt ?? right.createdAt,
        ),
      );
      const comments = ordered.slice(-MAX_COMMENTS);
      return {
        comments,
        truncated:
          history.truncated ||
          ordered.length > MAX_COMMENTS ||
          comments.some((comment) => comment.bodyTruncated === true),
      };
    } catch (cause) {
      throw githubError(
        "COMMENTS_READ_FAILED",
        "Could not read review comments.",
        cause,
      );
    }
  }

  async readAuthoritativeReport(
    number: number,
  ): Promise<ReviewComment | undefined> {
    return findAuthoritativeReport(await this.readComments(number));
  }

  async readIssueComment(commentId: string): Promise<ReviewComment> {
    try {
      const value = await this.client.getIssueComment(commentId);
      if (typeof value !== "object" || value === null) {
        throw githubError(
          "MALFORMED_COMMENT",
          "GitHub returned a malformed comment.",
        );
      }
      return normalizeComment(value, "issue");
    } catch (cause) {
      if (cause instanceof CodeReviewError) throw cause;
      throw githubError(
        "COMMENT_READ_FAILED",
        "Could not read the review marker.",
        cause,
      );
    }
  }

  async createReport(number: number, body: string): Promise<void> {
    try {
      await this.client.createIssueComment(number, body);
    } catch (cause) {
      throw githubError(
        "REPORT_CREATE_FAILED",
        "Could not publish the review report.",
        cause,
      );
    }
  }
  async updateReport(commentId: string, body: string): Promise<void> {
    try {
      await this.client.updateIssueComment(commentId, body);
    } catch (cause) {
      throw githubError(
        "REPORT_UPDATE_FAILED",
        "Could not update the review report.",
        cause,
      );
    }
  }
  async deleteComment(commentId: string): Promise<void> {
    try {
      await this.client.deleteIssueComment(commentId);
    } catch (cause) {
      throw githubError(
        "MARKER_DELETE_FAILED",
        "Could not remove the review marker.",
        cause,
      );
    }
  }
}
