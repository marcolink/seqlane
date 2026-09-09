export type CodeReviewErrorCategory =
  | "input-validation"
  | "github"
  | "runtime"
  | "publication";

export class CodeReviewError extends Error {
  constructor(
    readonly category: CodeReviewErrorCategory,
    readonly code: string,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "CodeReviewError";
  }
}
