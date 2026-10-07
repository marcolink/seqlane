import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  REVIEW_GIT_ARGS,
  type ReviewGitOptions,
} from "./review-git-config.js";
import {
  ReviewScopeError,
  ReviewScopeLimitError,
} from "./review-scope-errors.js";

/** Native fetch in a disposable Git directory, sharing only the target objects. */
export async function installReviewCheckpoint(
  options: {
    cwd: string;
    remote: NonNullable<ReviewGitOptions["trustedRemote"]>;
  },
  revisionValue: string,
  request: ReviewGitRequest,
) {
  const parsed = gitRevisionSchema.safeParse(revisionValue);
  if (!parsed.success)
    throw new ReviewScopeError(
      "GIT_FETCH_INVALID",
      "An exact checkpoint ID is required.",
      parsed.error,
    );
  const revision = parsed.data;
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
      argv: [...REVIEW_GIT_ARGS, "--no-replace-objects", ...argv],
      limits: { wallMs, outputBytes: request.limits.outputBytes - bytes },
    });
    stdout.push(Buffer.from(result.stdout));
    stderr.push(Buffer.from(result.stderr));
    bytes += result.stdout.byteLength + result.stderr.byteLength;
    return result;
  };
  const home = await mkdtemp(join(tmpdir(), "seqlane-review-fetch-")).catch(
    (cause: unknown) => {
      throw new ReviewScopeError(
        "GIT_FETCH_FAILED",
        "Checkpoint fetch could not create its temporary directory.",
        cause,
      );
    },
  );
  try {
    const env = reviewGitEnvironment(home);
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
    const directory = join(home, "checkpoint.git");
    const initialized = await run(
      home,
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
      home,
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
  } finally {
    await rm(home, { recursive: true, force: true }).catch((cause: unknown) => {
      throw new ReviewScopeError(
        "GIT_CLEANUP_FAILED",
        "Checkpoint fetch could not remove its temporary directory.",
        cause,
      );
    });
  }
}
