import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type {
  BoundedReviewGitPort,
  ReviewGitRequest,
} from "./review-git-budget.js";

const exec = promisify(execFile);
const measuredGitResultSchema = z.strictObject({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  wallMs: z.number().nonnegative(),
  cpuMs: z.number().nonnegative(),
  peakMemoryBytes: z.number().nonnegative(),
});

// Test adapter only. Python's wait4 measures real child CPU and peak RSS.
// It does not implement the production port's hard CPU/memory/transfer controls.
const measuredGit = `
import base64, json, resource, subprocess, sys, time
started = time.monotonic()
child = subprocess.Popen(["git", *sys.argv[2:]], cwd=sys.argv[1], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
stdout, stderr = child.communicate()
usage = resource.getrusage(resource.RUSAGE_CHILDREN)
print(json.dumps({"exitCode": child.returncode,
  "stdout": base64.b64encode(stdout).decode("ascii"),
  "stderr": base64.b64encode(stderr).decode("ascii"),
  "wallMs": (time.monotonic() - started) * 1000,
  "cpuMs": (usage.ru_utime + usage.ru_stime) * 1000,
  "peakMemoryBytes": usage.ru_maxrss * (1 if sys.platform == "darwin" else 1024)}))
`;

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
  const commands: ReviewGitRequest[] = [];
  return {
    cwd,
    commands,
    run,
    git: {
      run: async (request) => {
        commands.push(request);
        const result = await exec(
          "python3",
          ["-c", measuredGit, cwd, ...request.argv],
          {
            timeout: request.limits.wallMs,
            maxBuffer: 4_000_000,
          },
        );
        const value: unknown = JSON.parse(result.stdout);
        const parsed = measuredGitResultSchema.parse(value);
        return {
          exitCode: parsed.exitCode,
          stdout: Buffer.from(parsed.stdout, "base64"),
          stderr: Buffer.from(parsed.stderr, "base64"),
          stdoutTruncated: false,
          stderrTruncated: false,
          usage: {
            wallMs: parsed.wallMs,
            cpuMs: parsed.cpuMs,
            peakMemoryBytes: parsed.peakMemoryBytes,
            transferBytes: 0,
          },
        };
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
    dispose: () => rm(cwd, { recursive: true, force: true }),
  };
}
