import {
  gitRevisionSchema,
  pullRequestContextSchema,
  reviewCommentSchema,
  livePullRequestSchema,
  type PullRequestContext,
  type LivePullRequest,
  type ReviewComment,
  type ReviewHistory,
} from "./contracts.js";
import { CodeReviewError } from "./errors.js";
import { z } from "zod";

export interface GitHubReviewPort {
  readPullRequest(number: number): Promise<PullRequestContext>;
  readLivePullRequest(number: number): Promise<LivePullRequest>;
  readComments(number: number): Promise<ReviewHistory>;
  readAuthoritativeReport(number: number): Promise<ReviewComment | undefined>;
  readIssueComment(commentId: string): Promise<ReviewComment>;
  createMarker(number: number, body: string): Promise<string>;
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
type DispositionCommand = NonNullable<
  ReviewComment["omittedDispositionCommands"]
>[number];

interface ParsedDispositionCommand {
  readonly line: number;
  readonly command: DispositionCommand;
}

export interface DispositionCommandCandidate extends ParsedDispositionCommand {
  readonly commentIdentity: string;
  readonly commentTime: string;
}

interface DispositionCommandSelection {
  readonly total: number;
  readonly retained: readonly ParsedDispositionCommand[];
}

function retainNewestDispositionCommands(
  commands: Iterable<ParsedDispositionCommand>,
  limit = MAX_DISPOSITION_COMMANDS,
): DispositionCommandSelection {
  const retained: ParsedDispositionCommand[] = [];
  let total = 0;
  for (const command of commands) {
    total += 1;
    if (retained.length === limit) retained.shift();
    if (limit > 0) retained.push(command);
  }
  return { total, retained };
}

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

function parseDispositionCommand(
  line: string,
  lineIndex: number,
  authorAssociation: string,
): ParsedDispositionCommand | undefined {
  const match = line.match(COMMAND_PATTERN);
  if (match === null) return undefined;
  const actionValue = match[1];
  const findingId = match[2];
  if (actionValue === undefined || findingId === undefined) return undefined;
  const action = actionValue.toLowerCase() as
    "fixed" | "wont-fix" | "downgrade";
  const remainder = match[3]?.trim();
  let reason = remainder;
  let effectiveSeverity:
    "critical" | "required" | "optional" | "nit" | undefined;
  if (action === "downgrade") {
    const downgrade = remainder?.match(
      /^(?:to\s+)?(critical|required|optional|nit)(?:\s+(?:reason\s*[:=]\s*)?(.*))?$/i,
    );
    if (downgrade === undefined || downgrade === null) return undefined;
    effectiveSeverity = downgrade[1]!.toLowerCase() as typeof effectiveSeverity;
    reason = downgrade[2]?.trim();
  } else if (reason?.toLowerCase().startsWith("reason:")) {
    reason = reason.slice("reason:".length).trim();
  } else if (reason?.toLowerCase().startsWith("reason=")) {
    reason = reason.slice("reason=".length).trim();
  }
  return {
    line: lineIndex,
    command: {
      findingId,
      action,
      authorized: AUTHORIZED_ASSOCIATIONS.has(authorAssociation),
      ...(reason === undefined || reason.length === 0 ? {} : { reason }),
      ...(effectiveSeverity === undefined ? {} : { effectiveSeverity }),
    },
  };
}

function* parseDispositionCommands(
  body: string,
  authorAssociation: string,
): Generator<ParsedDispositionCommand> {
  let lineStart = 0;
  let lineIndex = 0;
  while (lineStart <= body.length) {
    const lineEnd = body.indexOf("\n", lineStart);
    const end = lineEnd === -1 ? body.length : lineEnd;
    const line = body.slice(lineStart, end).replace(/\r$/, "");
    const parsed = parseDispositionCommand(line, lineIndex, authorAssociation);
    if (parsed !== undefined) yield parsed;
    if (lineEnd === -1) return;
    lineStart = lineEnd + 1;
    lineIndex += 1;
  }
}

function compareDispositionCommands(
  left: DispositionCommandCandidate,
  right: DispositionCommandCandidate,
): number {
  return (
    left.commentTime.localeCompare(right.commentTime) ||
    left.commentIdentity.localeCompare(right.commentIdentity) ||
    left.line - right.line
  );
}

export function selectNewestDispositionCommands(
  candidates: Iterable<DispositionCommandCandidate>,
  limit = MAX_DISPOSITION_COMMANDS,
): ReadonlySet<string> {
  if (limit <= 0) return new Set();
  const heap: DispositionCommandCandidate[] = [];
  const siftUp = (index: number): void => {
    let child = index;
    while (child > 0) {
      const parent = Math.floor((child - 1) / 2);
      if (compareDispositionCommands(heap[parent]!, heap[child]!) <= 0) break;
      [heap[parent], heap[child]] = [heap[child]!, heap[parent]!];
      child = parent;
    }
  };
  const siftDown = (index: number): void => {
    let parent = index;
    while (true) {
      const left = parent * 2 + 1;
      const right = left + 1;
      let smallest = parent;
      if (
        left < heap.length &&
        compareDispositionCommands(heap[left]!, heap[smallest]!) < 0
      )
        smallest = left;
      if (
        right < heap.length &&
        compareDispositionCommands(heap[right]!, heap[smallest]!) < 0
      )
        smallest = right;
      if (smallest === parent) break;
      [heap[parent], heap[smallest]] = [heap[smallest]!, heap[parent]!];
      parent = smallest;
    }
  };
  for (const candidate of candidates) {
    if (heap.length < limit) {
      heap.push(candidate);
      siftUp(heap.length - 1);
    } else if (compareDispositionCommands(candidate, heap[0]!) > 0) {
      heap[0] = candidate;
      siftDown(0);
    }
  }
  return new Set(
    heap.map((candidate) => `${candidate.commentIdentity}:${candidate.line}`),
  );
}

function normalizeComment(
  value: object,
  kind: "issue" | "review",
  selection?: DispositionCommandSelection,
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
  const commandSelection =
    selection ??
    retainNewestDispositionCommands(
      parseDispositionCommands(
        originalBody.slice(0, MAX_COMMENT_BODY),
        String(source.author_association ?? "NONE"),
      ),
    );
  const commands = commandSelection.retained;
  const dispositionCommandsTruncated = commands.length < commandSelection.total;
  const body = trusted
    ? originalBody.slice(0, MAX_COMMENT_BODY)
    : lines
        .filter((line) => !line.toLowerCase().includes("/seqlane"))
        .join("\n")
        .slice(0, MAX_CONTEXT_BODY) +
      (commands.length === 0
        ? ""
        : `${lines.some((line) => line.match(COMMAND_PATTERN) !== null) ? "\n" : ""}${commands.map(({ command }) => `/seqlane ${command.action} ${command.findingId}${command.effectiveSeverity === undefined ? "" : ` ${command.effectiveSeverity}`}${command.reason === undefined ? "" : ` reason: ${command.reason}`}`).join("\n")}`);
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
    ...(commands.length === 0
      ? {}
      : {
          omittedDispositionCommands: commands.map(({ command }) => command),
        }),
    ...(dispositionCommandsTruncated
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

export interface CommentSource {
  readonly kind: "issue" | "review";
  readonly fetchPage: (page: number) => Promise<unknown>;
  readonly values: Map<string, unknown>;
  page: number;
  hasNextPage: boolean;
  lastFetched?: unknown;
}

function compareComments(
  left: readonly [unknown, "issue" | "review"],
  right: readonly [unknown, "issue" | "review"],
): number {
  return (
    commentTime(left[0]).localeCompare(commentTime(right[0])) ||
    commentIdentity(left[0], left[1]).localeCompare(
      commentIdentity(right[0], right[1]),
    )
  );
}

function orderedComments(
  sources: readonly CommentSource[],
): Array<readonly [unknown, "issue" | "review"]> {
  const values = new Map<string, readonly [unknown, "issue" | "review"]>();
  for (const source of sources)
    for (const [identity, value] of source.values)
      values.set(identity, [value, source.kind]);
  return [...values.values()].sort((left, right) =>
    compareComments(right, left),
  );
}

export async function readNewestComments(
  sources: readonly CommentSource[],
  limit = MAX_COMMENTS,
): Promise<{
  readonly values: ReadonlyArray<readonly [unknown, "issue" | "review"]>;
  readonly truncated: boolean;
}> {
  const readPage = async (source: CommentSource): Promise<void> => {
    const result = parseCommentPage(await source.fetchPage(source.page));
    const validItems = result.items.filter(
      (value): value is object => typeof value === "object" && value !== null,
    );
    for (const value of result.items) {
      if (typeof value === "object" && value !== null)
        source.values.set(commentIdentity(value, source.kind), value);
    }
    source.lastFetched = validItems.at(-1);
    source.hasNextPage = result.hasNextPage;
    source.page += 1;
  };
  await Promise.all(sources.map((source) => readPage(source)));
  while (sources.some((source) => source.hasNextPage)) {
    const ordered = orderedComments(sources);
    const boundary = ordered.length < limit ? undefined : ordered[limit - 1];
    const source = [...sources]
      .filter(
        (candidate) =>
          candidate.hasNextPage &&
          (boundary === undefined ||
            candidate.lastFetched === undefined ||
            compareComments(
              [candidate.lastFetched, candidate.kind],
              boundary,
            ) >= 0),
      )
      .sort((left, right) => {
        if (left.lastFetched === undefined) return -1;
        if (right.lastFetched === undefined) return 1;
        return compareComments(
          [right.lastFetched, right.kind],
          [left.lastFetched, left.kind],
        );
      })[0];
    if (source === undefined) break;
    await readPage(source);
  }
  const ordered = orderedComments(sources);
  return {
    values: ordered.slice(0, limit),
    truncated:
      sources.some((source) => source.hasNextPage) || ordered.length > limit,
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

  async readLivePullRequest(number: number): Promise<LivePullRequest> {
    try {
      const value = await this.client.getPullRequest(number);
      const source =
        typeof value === "object" && value !== null
          ? (value as Record<string, unknown>)
          : {};
      const head =
        typeof source.head === "object" && source.head !== null
          ? (source.head as Record<string, unknown>)
          : undefined;
      const headRepo =
        typeof head?.repo === "object" && head.repo !== null
          ? (head.repo as Record<string, unknown>)
          : undefined;
      const parsed = livePullRequestSchema.safeParse({
        ...(typeof source.state === "string" ? { state: source.state } : {}),
        ...(typeof source.draft === "boolean" ? { draft: source.draft } : {}),
        ...(head === undefined
          ? {}
          : {
              head: {
                ...(headRepo !== undefined &&
                typeof headRepo.full_name === "string"
                  ? { repo: { full_name: headRepo.full_name } }
                  : {}),
                ...(typeof head.sha === "string" ? { sha: head.sha } : {}),
              },
            }),
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
      const rawValues = history.values.filter(
        (entry): entry is readonly [object, "issue" | "review"] =>
          typeof entry[0] === "object" && entry[0] !== null,
      );
      const parsedValues = rawValues.map(([value, kind]) => {
        const source = value as Record<string, unknown>;
        const body = typeof source.body === "string" ? source.body : "";
        const authorAssociation = String(source.author_association ?? "NONE");
        const identity = commentIdentity(value, kind);
        return {
          value,
          kind,
          identity,
          time: commentTime(value),
          body,
          authorAssociation,
        };
      });
      let commandCount = 0;
      function* commandCandidates(): Generator<DispositionCommandCandidate> {
        for (const {
          identity,
          time,
          body,
          authorAssociation,
        } of parsedValues) {
          for (const parsed of parseDispositionCommands(
            body.slice(0, MAX_COMMENT_BODY),
            authorAssociation,
          )) {
            commandCount += 1;
            yield {
              ...parsed,
              commentIdentity: identity,
              commentTime: time,
            };
          }
        }
      }
      const retainedCommandKeys =
        selectNewestDispositionCommands(commandCandidates());
      const values = parsedValues.map(
        ({ value, kind, identity, body, authorAssociation }) => {
          let total = 0;
          const retained: ParsedDispositionCommand[] = [];
          for (const command of parseDispositionCommands(
            body.slice(0, MAX_COMMENT_BODY),
            authorAssociation,
          )) {
            total += 1;
            if (retainedCommandKeys.has(`${identity}:${command.line}`))
              retained.push(command);
          }
          return normalizeComment(value, kind, {
            total,
            retained,
          });
        },
      );
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
          comments.some((comment) => comment.bodyTruncated === true) ||
          commandCount > MAX_DISPOSITION_COMMANDS ||
          comments.some(
            (comment) => comment.omittedDispositionCommandsTruncated === true,
          ),
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

  async createMarker(number: number, body: string): Promise<string> {
    try {
      const value = await this.client.createIssueComment(number, body);
      if (typeof value !== "object" || value === null) {
        throw githubError(
          "MALFORMED_COMMENT",
          "GitHub returned a malformed created marker comment.",
        );
      }
      const id = (value as Record<string, unknown>).id;
      if (typeof id !== "string" && typeof id !== "number") {
        throw githubError(
          "MALFORMED_COMMENT",
          "GitHub returned a created marker without an ID.",
        );
      }
      return String(id);
    } catch (cause) {
      if (cause instanceof CodeReviewError) throw cause;
      throw githubError(
        "MARKER_CREATE_FAILED",
        "Could not create the review marker.",
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
