import { z } from "zod";
import { isAbsolute } from "node:path";
import { ReviewScopeError } from "./review-scope-errors.js";

const absolutePathSchema = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    if (!isAbsolute(value))
      context.addIssue({
        code: "custom",
        message: "An absolute host path is required",
      });
  });
export const reviewGitHostOptionsSchema = z.strictObject({
  reviewTarget: absolutePathSchema,
  cgroupRoot: absolutePathSchema,
  trustedRemote: z
    .strictObject({
      url: z.url().superRefine((value, context) => {
        const url = new URL(value);
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        ) {
          context.addIssue({
            code: "custom",
            message: "A trusted credential-free HTTPS Git URL is required",
          });
        }
      }),
      authorization: z
        .string()
        .min(1)
        .max(8192)
        .regex(/^[^\r\n]+$/)
        .optional(),
    })
    .optional(),
  signal: z.instanceof(AbortSignal).optional(),
});
export type ReviewGitHostOptions = z.input<typeof reviewGitHostOptionsSchema>;

// No caller-controlled -c, aliases, executable helpers, or general Git commands.
// Diff options remain the collector's responsibility; its fixed flags disable
// external diff/textconv and literal-pathspecs protects the trailing inventory.
export function requireLocalReviewGit(argv: readonly string[]): void {
  const args = [...argv];
  if (args.shift() !== "--no-replace-objects") throw invalidCommand();
  if (args[0] === "-c" && args[1] === "core.quotePath=true") args.splice(0, 2);
  if (args[0] === "--literal-pathspecs") args.shift();
  const command = args.shift();
  if (
    command === "cat-file" &&
    args.length === 2 &&
    args[0] === "-t" &&
    /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(args[1] ?? "")
  )
    return;
  if (
    command === "rev-parse" &&
    (args.join(" ") === "--show-object-format=storage" ||
      args.join(" ") === "--verify HEAD" ||
      (args.length === 3 &&
        args[0] === "--verify" &&
        args[1] === "--end-of-options" &&
        /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(args[2] ?? "")))
  )
    return;
  if (command !== "diff" || !args.includes("--")) throw invalidCommand();
  const boundary = args.indexOf("--");
  const before = args.slice(0, boundary);
  const allowed = new Set([
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--no-renames",
    "--ignore-submodules=none",
    "--name-status",
    "-z",
    "--raw",
    "--patch",
    "--no-abbrev",
    "--full-index",
    "--binary",
    "--unified=10",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--no-relative",
    "--submodule=short",
    "--output-indicator-new=+",
    "--output-indicator-old=-",
    "--output-indicator-context= ",
  ]);
  if (
    !before.includes("--no-ext-diff") ||
    !before.includes("--no-textconv") ||
    before.some(
      (value) =>
        !allowed.has(value) &&
        !/^[0-9a-f]{40}(?:[0-9a-f]{24})?(?:\.\.\.[0-9a-f]{40}(?:[0-9a-f]{24})?)?$/.test(
          value,
        ),
    )
  )
    throw invalidCommand();
}

function invalidCommand() {
  return new ReviewScopeError(
    "GIT_HOST_COMMAND",
    "Only the collector's local Git operations are allowed.",
  );
}

export function reviewGitEnvironment(home: string) {
  return {
    PATH: "/usr/bin:/bin",
    HOME: home,
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_NO_LAZY_FETCH: "1",
    GIT_ALLOW_PROTOCOL: "",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

export const REVIEW_GIT_HOST_ARGS = Object.freeze([
  "--literal-pathspecs",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "credential.helper=",
  "-c",
  "core.pager=cat",
  "-c",
  "core.alternateRefsCommand=",
]);
