import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { createReviewGitHost } from "./review-git-host.js";
import type {
  BoundedReviewGitPort,
  ReviewGitRequest,
} from "./review-git-budget.js";

const exec = promisify(execFile);
export async function createReviewGitFixture(
  objectFormat: "sha1" | "sha256" = "sha1",
): Promise<{
  cwd: string;
  git: BoundedReviewGitPort;
  commands: ReviewGitRequest[];
  run: (...argv: string[]) => Promise<string>;
  write: (path: string, content: string | Uint8Array) => Promise<void>;
  commit: () => Promise<string>;
  dispose: () => Promise<void>;
}> {
  const cwd = await mkdtemp(join(tmpdir(), "seqlane-review-scope-"));
  const run = async (...argv: string[]) =>
    (await exec("git", argv, { cwd })).stdout.trim();
  await run(
    "init",
    "-q",
    "--initial-branch=fixture",
    `--object-format=${objectFormat}`,
  );
  await run("config", "user.name", "Review fixture");
  await run("config", "user.email", "review@example.test");
  const host = await createReviewGitHost({ reviewTarget: cwd });
  const commands: ReviewGitRequest[] = [];
  return {
    cwd,
    commands,
    run,
    git: {
      run: async (request) => {
        commands.push(request);
        return host.git.run(request);
      },
    },
    write: async (path, content) => {
      await mkdir(dirname(join(cwd, path)), { recursive: true });
      await writeFile(join(cwd, path), content);
    },
    commit: async () => {
      await run("add", "--all");
      await run(
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "-qm",
        "Fixture change",
      );
      return run("rev-parse", "HEAD");
    },
    dispose: async () => {
      await host.close();
      await rm(cwd, { recursive: true, force: true });
    },
  };
}
