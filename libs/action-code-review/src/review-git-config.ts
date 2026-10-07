import { z } from "zod";
import { isAbsolute } from "node:path";

const absolutePathSchema = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    if (!isAbsolute(value) || value.includes("\0"))
      context.addIssue({
        code: "custom",
        message: "An absolute host path is required",
      });
  });
export const reviewGitOptionsSchema = z.strictObject({
  reviewTarget: absolutePathSchema,
});
export type ReviewGitOptions = z.input<typeof reviewGitOptionsSchema>;

export function reviewGitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    HOME: "/dev/null",
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

export const REVIEW_GIT_ARGS = Object.freeze([
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
