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
        .regex(/^[^\r\n\0]+$/)
        .optional(),
    })
    .optional(),
});
export type ReviewGitOptions = z.input<typeof reviewGitOptionsSchema>;

export function reviewGitEnvironment(home = "/dev/null"): NodeJS.ProcessEnv {
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
