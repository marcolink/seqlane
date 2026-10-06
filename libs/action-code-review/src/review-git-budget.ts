import { z } from "zod";
import { REVIEW_GIT_LIMITS } from "./review-scope-contracts.js";
import { requireScopeLimit, ReviewScopeError } from "./review-scope-errors.js";

export interface ReviewGitRequest {
  readonly argv: readonly string[];
  readonly limits: {
    readonly wallMs: number;
    readonly cpuMs: number;
    readonly peakMemoryBytes: number;
    readonly outputBytes: number;
    readonly transferBytes: number;
  };
  readonly signal?: AbortSignal;
}

/** Trusted host port: stream raw bytes, enforce limits, and reap the whole group.
 * Missing resource measurements are errors, never zero-valued defaults.
 * Fetch must use a trusted remote and transfer accounting, without shell argv.
 * Local operations must disable lazy fetch (GIT_NO_LAZY_FETCH=1).
 */
export interface BoundedReviewGitPort {
  run(request: ReviewGitRequest): Promise<unknown>;
  fetchExactCommit?(
    revision: string,
    request: ReviewGitRequest,
  ): Promise<unknown>;
}

const gitResultSchema = z.strictObject({
  exitCode: z.number().int(),
  stdout: z.instanceof(Uint8Array),
  stderr: z.instanceof(Uint8Array),
  stdoutTruncated: z.literal(false),
  stderrTruncated: z.literal(false),
  usage: z.strictObject({
    wallMs: z.number().finite().nonnegative(),
    cpuMs: z.number().finite().nonnegative(),
    peakMemoryBytes: z.number().int().nonnegative(),
    transferBytes: z.number().int().nonnegative(),
  }),
});

export class ReviewGitBudget {
  private wallMs = 0;
  private cpuMs = 0;
  private outputBytes = 0;
  private lastObservedTime: number;

  constructor(
    private readonly port: BoundedReviewGitPort,
    private readonly admittedAt: number,
    private readonly now: () => number,
    private readonly signal?: AbortSignal,
  ) {
    this.lastObservedTime = admittedAt;
  }

  assertActive(operation: string): number {
    if (this.signal?.aborted) {
      throw new ReviewScopeError(
        "REVIEW_SCOPE_CANCELLED",
        "Review scope collection was cancelled.",
        this.signal.reason,
      );
    }
    const current = this.now();
    if (!Number.isFinite(current) || current < this.lastObservedTime) {
      throw new ReviewScopeError(
        "INVALID_ADMISSION_TIME",
        "Review budget requires a monotonic clock.",
      );
    }
    this.lastObservedTime = current;
    const elapsed = current - this.admittedAt;
    requireScopeLimit(
      "admissionWallMs",
      elapsed,
      REVIEW_GIT_LIMITS.admissionWallMs,
      operation,
    );
    return elapsed;
  }

  private request(argv: readonly string[], fetch: boolean): ReviewGitRequest {
    const elapsed = this.assertActive("git-admission");
    const wallMs = Math.min(
      fetch ? REVIEW_GIT_LIMITS.fetchWallMs : REVIEW_GIT_LIMITS.commandWallMs,
      REVIEW_GIT_LIMITS.totalWallMs - this.wallMs,
      REVIEW_GIT_LIMITS.admissionWallMs - elapsed,
    );
    const cpuMs = REVIEW_GIT_LIMITS.totalCpuMs - this.cpuMs;
    if (wallMs <= 0 || cpuMs <= 0) {
      throw new ReviewScopeError(
        "REVIEW_SCOPE_BUDGET_EXHAUSTED",
        "No Git execution budget remains.",
      );
    }
    return {
      argv: ["--no-replace-objects", ...argv],
      limits: {
        wallMs,
        cpuMs,
        peakMemoryBytes: REVIEW_GIT_LIMITS.peakMemoryBytes,
        outputBytes: REVIEW_GIT_LIMITS.outputBytes - this.outputBytes,
        transferBytes: fetch ? REVIEW_GIT_LIMITS.fetchBytes : 0,
      },
      signal: this.signal,
    };
  }

  async run(argv: readonly string[]): Promise<z.infer<typeof gitResultSchema>> {
    const request = this.request(argv, false);
    return this.account(await this.port.run(request), request, argv.join(" "));
  }

  async fetchExactCommit(
    revision: string,
  ): Promise<z.infer<typeof gitResultSchema>> {
    const request = this.request([], true);
    if (this.port.fetchExactCommit === undefined) {
      throw new ReviewScopeError(
        "CHECKPOINT_UNAVAILABLE",
        "The exact checkpoint commit is unavailable.",
      );
    }
    return this.account(
      await this.port.fetchExactCommit(revision, request),
      request,
      "exact-checkpoint-fetch",
    );
  }

  private account(
    value: unknown,
    request: ReviewGitRequest,
    operation: string,
  ) {
    const result = gitResultSchema.parse(value);
    this.wallMs += result.usage.wallMs;
    this.cpuMs += result.usage.cpuMs;
    this.outputBytes += result.stdout.byteLength + result.stderr.byteLength;
    const checks: [string, number, number][] = [
      ["commandWallMs", result.usage.wallMs, request.limits.wallMs],
      ["commandCpuMs", result.usage.cpuMs, request.limits.cpuMs],
      [
        "peakMemoryBytes",
        result.usage.peakMemoryBytes,
        request.limits.peakMemoryBytes,
      ],
      [
        "transferBytes",
        result.usage.transferBytes,
        request.limits.transferBytes,
      ],
      ["totalWallMs", this.wallMs, REVIEW_GIT_LIMITS.totalWallMs],
      ["totalCpuMs", this.cpuMs, REVIEW_GIT_LIMITS.totalCpuMs],
      ["outputBytes", this.outputBytes, REVIEW_GIT_LIMITS.outputBytes],
    ];
    for (const [resource, observed, limit] of checks) {
      requireScopeLimit(resource, observed, limit, operation);
    }
    this.assertActive(operation);
    return result;
  }
}
