import { join, isAbsolute } from "node:path";
import { z } from "zod";
import { gitRevisionSchema } from "./contracts.js";
import {
  reviewGitResultSchema,
  type ReviewGitRequest,
} from "./review-git-budget.js";
import { runReviewGit } from "./review-git-process.js";
import {
  reviewGitEnvironment,
  REVIEW_GIT_HOST_ARGS,
  type ReviewGitHostOptions,
} from "./review-git-host-policy.js";
import {
  ReviewScopeError,
  ReviewScopeLimitError,
} from "./review-scope-errors.js";

/** Native fetch in a disposable Git directory, sharing only the target objects. */
export async function installReviewCheckpoint(
  options: {
    home: string;
    cwd: string;
    remote: NonNullable<ReviewGitHostOptions["trustedRemote"]>;
  },
  revisionValue: string,
  request: ReviewGitRequest,
) {
  const revision = gitRevisionSchema.parse(revisionValue);
  if (request.argv.length !== 1 || request.argv[0] !== "--no-replace-objects")
    throw new ReviewScopeError(
      "GIT_HOST_COMMAND",
      "Exact fetch accepts no caller-selected Git options.",
    );
  const started = performance.now();
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  const run = async (cwd: string, argv: string[], env: NodeJS.ProcessEnv) => {
    const wallMs = request.limits.wallMs - (performance.now() - started);
    if (wallMs <= 0)
      throw new ReviewScopeLimitError(
        "commandWallMs",
        performance.now() - started,
        request.limits.wallMs,
        "exact-checkpoint-fetch",
      );
    const result = await runReviewGit(cwd, env, {
      ...request,
      argv: [...REVIEW_GIT_HOST_ARGS, "--no-replace-objects", ...argv],
      limits: { wallMs, outputBytes: request.limits.outputBytes - bytes },
    });
    stdout.push(Buffer.from(result.stdout));
    stderr.push(Buffer.from(result.stderr));
    bytes += result.stdout.byteLength + result.stderr.byteLength;
    return result;
  };
  const env = reviewGitEnvironment(options.home);
  const finish = (result: z.output<typeof reviewGitResultSchema>) => ({
    ...result,
    stdout: Buffer.concat(stdout),
    stderr: Buffer.concat(stderr),
    usage: { wallMs: performance.now() - started },
  });
  const objectPath = await run(
    options.cwd,
    ["rev-parse", "--path-format=absolute", "--git-path", "objects"],
    env,
  );
  if (objectPath.exitCode !== 0) return finish(objectPath);
  const objects = z
    .string()
    .refine(isAbsolute)
    .parse(
      new TextDecoder("utf-8", { fatal: true })
        .decode(objectPath.stdout)
        .replace(/\n$/, ""),
    );
  const directory = join(options.home, "checkpoint.git");
  const initialized = await run(
    options.home,
    [
      "init",
      "--bare",
      `--object-format=${revision.length === 64 ? "sha256" : "sha1"}`,
      directory,
    ],
    env,
  );
  if (initialized.exitCode !== 0) return finish(initialized);
  const authorization = options.remote.authorization;
  const fetched = await run(
    options.home,
    [
      `--git-dir=${directory}`,
      "-c",
      "http.followRedirects=false",
      ...(authorization === undefined
        ? []
        : ["--config-env=http.extraHeader=SEQLANE_REVIEW_GIT_AUTH"]),
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      "--no-write-fetch-head",
      "--no-auto-maintenance",
      "--depth=1",
      "--",
      options.remote.url,
      revision,
    ],
    {
      ...env,
      GIT_OBJECT_DIRECTORY: objects,
      GIT_ALLOW_PROTOCOL: "https",
      ...(authorization === undefined
        ? {}
        : { SEQLANE_REVIEW_GIT_AUTH: `Authorization: ${authorization}` }),
      ...(process.env.GIT_SSL_CAINFO === undefined
        ? {}
        : { GIT_SSL_CAINFO: process.env.GIT_SSL_CAINFO }),
    },
  );
  return finish(fetched);
}
