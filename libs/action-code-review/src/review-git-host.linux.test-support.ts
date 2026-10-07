import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReviewGitHost } from "./review-git-host.js";
import { superviseReviewGit } from "./review-git-supervisor.js";
import { reviewGitEnvironment } from "./review-git-host-policy.js";
import {
  reviewGitResultSchema,
  type ReviewGitRequest,
} from "./review-git-budget.js";
import { admitReviewScope } from "./review-scope-admission.js";
import { createReviewStateFixture } from "./review-state-fixture.test-support.js";
import { encodeReviewStateV5 } from "./review-state-codec.js";
import { verifyReviewGitFetch } from "./review-git-fetch.linux.test-support.js";

const exec = promisify(execFile);
const limits = {
  wallMs: 3000,
  cpuMs: 2000,
  peakMemoryBytes: 64 * 1024 * 1024,
  outputBytes: 65_536,
  transferBytes: 0,
};

async function verifySupervisor(cwd: string, cgroupRoot: string) {
  const run = (code: string, request: Partial<ReviewGitRequest> = {}) =>
    superviseReviewGit(
      {
        cwd,
        cgroupRoot,
        executable: "/usr/bin/python3",
        env: reviewGitEnvironment(cwd),
      },
      { argv: ["-I", "-c", code], limits, ...request },
    );
  const output = await run(
    "import os; os.write(1, b'a'*32); os.write(2, b'b'*32)",
    { limits: { ...limits, outputBytes: 64 } },
  );
  assert.equal(output.stdout.byteLength + output.stderr.byteLength, 64);
  await assert.rejects(
    run("import os; os.write(1, b'a'*32); os.write(2, b'b'*33)", {
      limits: { ...limits, outputBytes: 64 },
    }),
    { resource: "outputBytes", limit: 64 },
  );
  await assert.rejects(
    run("import time; time.sleep(10)", { limits: { ...limits, wallMs: 100 } }),
    { resource: "commandWallMs" },
  );
  await assert.rejects(
    run("while True: pass", { limits: { ...limits, cpuMs: 100 } }),
    { resource: "commandCpuMs" },
  );
  await assert.rejects(
    run("blocks=[]\nwhile True: blocks.append(bytearray(1024*1024))", {
      limits: { ...limits, peakMemoryBytes: 32 * 1024 * 1024 },
    }),
    { resource: "peakMemoryBytes" },
  );
  const network = await run("import socket; socket.socket()");
  assert.notEqual(network.exitCode, 0);
  assert.match(
    Buffer.from(network.stderr).toString(),
    /Operation not permitted/,
  );
  const pidPath = join(cwd, "descendant.pid");
  const daemon = `import os,signal,time\npid=os.fork()\nif pid == 0:\n os.setsid()\n signal.signal(signal.SIGTERM, signal.SIG_IGN)\n open(${JSON.stringify(pidPath)}, 'w').write(str(os.getpid()))\n while True: time.sleep(1)\ntime.sleep(.05)`;
  await run(daemon);
  const { readFile } = await import("node:fs/promises");
  const pid = Number(await readFile(pidPath, "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  const controller = new AbortController();
  const cancelled = run("import time; time.sleep(10)", {
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(cancelled, { code: "REVIEW_SCOPE_CANCELLED" });
  await assert.rejects(
    run(daemon.replace("time.sleep(.05)", "time.sleep(10)"), {
      limits: { ...limits, wallMs: 150 },
    }),
    { resource: "commandWallMs" },
  );
  const stoppedPid = Number(await readFile(pidPath, "utf8"));
  assert.throws(() => process.kill(stoppedPid, 0), { code: "ESRCH" });
  assert.deepEqual(await readdir(cgroupRoot), await controlNames(cgroupRoot));
}

async function controlNames(cgroupRoot: string) {
  return (await readdir(cgroupRoot)).filter(
    (name) => !name.startsWith("seqlane-"),
  );
}

async function verifyAdmission(
  cwd: string,
  cgroupRoot: string,
  objectFormat: "sha1" | "sha256",
) {
  const git = async (...argv: string[]) =>
    (await exec("/usr/bin/git", argv, { cwd })).stdout.trim();
  await git(
    "init",
    "-q",
    "--initial-branch=fixture",
    `--object-format=${objectFormat}`,
  );
  await git("config", "user.name", "Review fixture");
  await git("config", "user.email", "review@example.test");
  const commit = async () => {
    await git("add", "--all");
    await git("commit", "-qm", "Fixture");
    return git("rev-parse", "HEAD");
  };
  await writeFile(join(cwd, "first.ts"), "base\n");
  await writeFile(join(cwd, "later.ts"), "base\n");
  const baseRevision = await commit();
  await writeFile(join(cwd, "first.ts"), "earlier reviewed hunk\n");
  const checkpoint = await commit();
  await writeFile(join(cwd, "later.ts"), "new edit\n");
  const headRevision = await commit();
  const host = await createReviewGitHost({ reviewTarget: cwd, cgroupRoot });
  const observed: string[][] = [];
  const bounded = {
    run: async (request: ReviewGitRequest) => {
      observed.push([...request.argv]);
      return host.git.run(request);
    },
  };
  const state = createReviewStateFixture(baseRevision, checkpoint);
  const page = {
    items: [
      {
        id: 42,
        user: { login: "github-actions[bot]" },
        author_association: "NONE",
        body: encodeReviewStateV5(state),
        created_at: "2026-10-07",
        updated_at: "2026-10-07",
      },
    ],
    hasNextPage: false,
  };
  const authority = { listIssueComments: async () => page };
  const pullRequest = {
    repositoryId: "1",
    pullRequestNumber: 112,
    targetBranch: "release",
    baseRevision,
    headRevision,
  };
  try {
    const admission = await admitReviewScope(
      { pullRequest },
      { authority, git: bounded, admittedAt: performance.now() },
    );
    assert.equal(admission.scopeIdentity.mode, "incremental");
    assert.deepEqual(admission.evidence.reviewablePaths, ["later.ts"]);
    assert.match(admission.evidence.batches[0]?.patch ?? "", /new edit/);
    assert.doesNotMatch(
      admission.evidence.batches[0]?.patch ?? "",
      /earlier reviewed hunk/,
    );
    assert.equal(observed.filter((args) => args.includes("--patch")).length, 2);
    const report = page.items[0];
    assert.ok(report);
    report.body = encodeReviewStateV5(
      createReviewStateFixture(baseRevision, headRevision),
    );
    observed.length = 0;
    const sameHead = await admitReviewScope(
      { pullRequest },
      { authority, git: bounded, admittedAt: performance.now() },
    );
    assert.equal(sameHead.evidence.batches.length, 0);
    assert.equal(observed.filter((args) => args.includes("--patch")).length, 0);
    const result = reviewGitResultSchema.parse(
      await host.git.run({
        argv: ["--no-replace-objects", "cat-file", "-t", checkpoint],
        limits,
      }),
    );
    assert.ok(result.usage.cpuMs > 0);
    assert.ok(result.usage.peakMemoryBytes > 0);
    assert.equal(result.usage.transferBytes, 0);
    const hostilePaths = [
      ":(glob)*.ts",
      "-odd.ts",
      'quote"file.ts',
      "line\nbreak.ts",
    ];
    for (const path of hostilePaths)
      await writeFile(join(cwd, path), "literal path\n");
    const literalHead = await commit();
    const baseline = await admitReviewScope(
      { pullRequest: { ...pullRequest, headRevision: literalHead } },
      {
        authority: {
          listIssueComments: async () => ({ items: [], hasNextPage: false }),
        },
        git: bounded,
        admittedAt: performance.now(),
      },
    );
    assert.equal(baseline.scopeIdentity.mode, "new-baseline");
    assert.deepEqual(
      new Set(baseline.evidence.reviewablePaths),
      new Set(["first.ts", "later.ts", ...hostilePaths]),
    );
    await assert.rejects(
      host.git.run({ argv: ["--no-replace-objects", "status"], limits }),
      { code: "GIT_HOST_COMMAND" },
    );
    await assert.rejects(
      host.git.run({
        argv: ["--no-replace-objects", "rev-parse", "--verify", "HEAD"],
        limits: { ...limits, wallMs: 1 },
      }),
      { resource: "commandWallMs" },
    );
    const pending = host.git.run({
      argv: ["--no-replace-objects", "rev-parse", "--verify", "HEAD"],
      limits,
    });
    await assert.rejects(
      host.git.run({
        argv: ["--no-replace-objects", "rev-parse", "--verify", "HEAD"],
        limits,
      }),
      { code: "GIT_HOST_BUSY" },
    );
    await pending;
    await git("config", "remote.fixture.promisor", "true");
    await git(
      "config",
      "remote.fixture.url",
      "https://example.invalid/untrusted.git",
    );
    await git("config", "extensions.partialClone", "fixture");
    const missing = reviewGitResultSchema.parse(
      await host.git.run({
        argv: [
          "--no-replace-objects",
          "cat-file",
          "-t",
          "a".repeat(literalHead.length),
        ],
        limits,
      }),
    );
    assert.notEqual(missing.exitCode, 0);
    assert.equal(missing.usage.transferBytes, 0);
    const cancelledRun = host.git.run({
      argv: ["--no-replace-objects", "rev-parse", "--verify", "HEAD"],
      limits,
    });
    const closing = [host.close(), host.close()];
    await assert.rejects(cancelledRun, { code: "REVIEW_SCOPE_CANCELLED" });
    await Promise.all(closing);
  } finally {
    await host.close();
  }
  await verifyReviewGitFetch(cwd, cgroupRoot);
}

/** Linux smoke gate also runs from a bundle outside the source checkout. */
export async function verifyReviewGitHost(cgroupRoot: string) {
  assert.equal(
    process.platform,
    "linux",
    "Live host verification requires Linux",
  );
  const cwd = await mkdtemp(join(tmpdir(), "seqlane-git-host-fixture-"));
  try {
    await verifySupervisor(cwd, cgroupRoot);
    for (const format of ["sha1", "sha256"] as const) {
      const repo = join(cwd, format);
      await mkdir(repo);
      await verifyAdmission(repo, cgroupRoot, format);
    }
    assert.deepEqual(await readdir(cgroupRoot), await controlNames(cgroupRoot));
    return {
      status: "verified",
      platform: process.platform,
      git: (await exec("/usr/bin/git", ["--version"])).stdout.trim(),
      kernel: (await exec("uname", ["-r"])).stdout.trim(),
      architecture: process.arch,
      python: (await exec("/usr/bin/python3", ["--version"])).stdout.trim(),
      controllers: "cpu memory pids",
      cleanup: "no workload cgroups or surviving descendants",
    };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
