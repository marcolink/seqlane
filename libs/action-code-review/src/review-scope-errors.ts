import { CodeReviewError } from "./errors.js";

export class ReviewScopeError extends CodeReviewError {
  constructor(code: string, message: string, cause?: unknown) {
    super("input-validation", code, message, { cause });
    this.name = "ReviewScopeError";
  }
}

export class ReviewScopeLimitError extends ReviewScopeError {
  constructor(
    readonly resource: string,
    readonly observed: number,
    readonly limit: number,
    readonly operation: string,
  ) {
    super("REVIEW_SCOPE_LIMIT", `Review scope exceeded ${resource}.`);
    this.name = "ReviewScopeLimitError";
  }
}

export function requireScopeLimit(
  resource: string,
  observed: number,
  limit: number,
  operation: string,
): void {
  if (observed > limit) {
    throw new ReviewScopeLimitError(resource, observed, limit, operation);
  }
}
