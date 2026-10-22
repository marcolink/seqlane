// @test-scope ../actions/code-review/src/main.ts
// @test-scope ../actions/code-review/src/post.ts
// @test-scope ../actions/resolve-merge-conflicts/src/main.ts
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const repository = resolve(import.meta.dirname, "..");

export function outputFields(contents) {
  const lines = contents.split(/\r?\n/);
  const values = {};
  for (let index = 0; index < lines.length; index++) {
    if (lines[index] === "") continue;
    const match = /^([^<]+)<<(.+)$/.exec(lines[index]);
    assert(match, "Expected Actions Toolkit file command");
    const chunks = [];
    while (++index < lines.length && lines[index] !== match[2])
      chunks.push(lines[index]);
    assert(index < lines.length, "Incomplete Actions Toolkit file command");
    values[match[1]] = chunks.join("\n");
  }
  return values;
}

async function waitForApiShutdown(url) {
  const deadline = AbortSignal.timeout(5_000);
  while (!deadline.aborted) {
    const requestTimeout = AbortSignal.timeout(250);
    let response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.any([deadline, requestTimeout]),
      });
    } catch (cause) {
      const code = cause?.cause?.code;
      if (code === "ECONNREFUSED") return;
      if (
        code !== "ECONNRESET" &&
        code !== "UND_ERR_SOCKET" &&
        !requestTimeout.aborted &&
        !deadline.aborted
      )
        throw cause;
    }
    await response?.body?.cancel();
    await delay(50);
  }
  assert.fail("Fixture API listener survived SIGTERM");
}

export async function verifyActionFixtures() {
  const directory = await mkdtemp(join(tmpdir(), "seqlane-bundled-fixtures-"));
  const envPath = join(directory, "env");
  await writeFile(envPath, "");
  let modelRequests = 0;
  const runtime = createServer((_request, response) => {
    modelRequests++;
    response.writeHead(403).end("Model calls are forbidden in this fixture");
  });
  runtime.listen(0, "127.0.0.1");
  await once(runtime, "listening");
  const env = {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    RUNNER_TEMP: directory,
    GITHUB_ENV: envPath,
    GITHUB_REPOSITORY: "fixture/seqlane",
    GITHUB_WORKSPACE: repository,
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: "0".repeat(40),
  };
  const fixtureScript = join(repository, "scripts/action-hosted-smoke.mjs");
  const requestsPath = join(directory, "seqlane-action-smoke/requests.jsonl");
  const entrypoint = (action, name, inputEnv) =>
    run(process.execPath, [join(repository, "actions", action, "dist", name)], {
      cwd: directory,
      env: inputEnv,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
  try {
    // No captured pipe stays attached to the detached fixture API.
    const prepare = spawn(process.execPath, [fixtureScript, "prepare"], {
      cwd: directory,
      env,
      stdio: "ignore",
    });
    const [code] = await once(prepare, "exit", {
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(code, 0, "Hosted fixture preparation failed");
    for (const line of (await readFile(envPath, "utf8")).trim().split("\n")) {
      const separator = line.indexOf("=");
      env[line.slice(0, separator)] = line.slice(separator + 1);
    }
    const statePath = join(directory, "state");
    const outputPath = join(directory, "output");
    const summaryPath = join(directory, "summary");
    await Promise.all(
      [statePath, outputPath, summaryPath].map((path) => writeFile(path, "")),
    );
    const actionEnv = {
      ...env,
      // Simulate the runner restoring reserved variables after workflow env.
      GITHUB_API_URL: "https://api.github.com",
      GITHUB_WORKSPACE: repository,
      NODE_OPTIONS: `--require=${env.SMOKE_API_PRELOAD}`,
      GITHUB_STATE: statePath,
      GITHUB_OUTPUT: outputPath,
      GITHUB_STEP_SUMMARY: summaryPath,
    };
    const reviewEnv = {
      ...actionEnv,
      "INPUT_GITHUB-TOKEN": "hosted-fixture-token",
      INPUT_REPOSITORY: env.GITHUB_REPOSITORY,
      "INPUT_PULL-REQUEST-NUMBER": "1",
      "INPUT_REVIEW-TARGET": env.SMOKE_TARGET,
      "INPUT_BASE-BRANCH": "main",
      "INPUT_BASE-REVISION": env.SMOKE_SHA,
      "INPUT_HEAD-REVISION": env.SMOKE_SHA,
      INPUT_RUNTIME: `http://127.0.0.1:${runtime.address().port}`,
    };
    await entrypoint("code-review", "main.js", reviewEnv);
    const review = outputFields(await readFile(outputPath, "utf8"));
    assert.equal(review.verdict, "stale");
    assert.equal(review["publication-status"], "stale");
    const state = outputFields(await readFile(statePath, "utf8"));
    await entrypoint("code-review", "post.js", {
      ...reviewEnv,
      ...Object.fromEntries(
        Object.entries(state).map(([key, value]) => [`STATE_${key}`, value]),
      ),
    });
    await writeFile(outputPath, "");
    await entrypoint("resolve-merge-conflicts", "main.js", {
      ...actionEnv,
      GITHUB_TOKEN: "hosted-fixture-token",
      "INPUT_PULL-REQUEST-NUMBER": "2",
      "INPUT_RESOLUTION-STRATEGY": "rebase",
      "INPUT_SOURCE-DIRECTORY": env.SMOKE_SOURCE_DIRECTORY,
      "INPUT_TARGET-DIRECTORY": env.SMOKE_TARGET_DIRECTORY,
      INPUT_COMMIT: "false",
      INPUT_PUSH: "false",
      "INPUT_MAX-ATTEMPTS": "10",
      "INPUT_CONFLICT-HANDLERS": '{"version":1,"rules":[]}',
    });
    const conflicts = outputFields(await readFile(outputPath, "utf8"));
    assert.equal(conflicts.result, "no-change");
    assert.equal(conflicts.pushed, "false");
    assert.equal(conflicts.attempts, "0");
    assert.equal(
      modelRequests,
      0,
      "A compiled Action called the model runtime",
    );
    const requests = (await readFile(requestsPath, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert(
      requests.length >= 5,
      "Compiled Actions did not use the fixture API",
    );
    assert(requests.every(({ method }) => method === "GET"));
    const git = (...args) => run("git", args, { cwd: env.SMOKE_TARGET, env });
    assert.equal((await git("status", "--porcelain")).stdout.trim(), "");
    assert.equal((await git("rev-parse", "HEAD")).stdout.trim(), env.SMOKE_SHA);
    assert.equal(
      (
        await fetch(`${env.SMOKE_API_URL}/repos/fixture/seqlane/pulls/1`, {
          method: "POST",
        })
      ).status,
      403,
      "Fixture API must reject publication writes",
    );
    assert.equal(
      (await fetch(`${env.SMOKE_API_URL}/%ZZ`)).status,
      400,
      "Malformed fixture routes must be rejected",
    );
    console.log(
      "Review and resolver bundles: runner env restored, stale review, no-change/false, zero model calls, GET-only Action requests, unchanged Git, writes denied.",
    );
  } catch (cause) {
    console.error(await readFile(requestsPath, "utf8").catch(() => ""));
    throw cause;
  } finally {
    const contents = await readFile(envPath, "utf8");
    const apiPid = Number(/^SMOKE_API_PID=(.+)$/m.exec(contents)?.[1]);
    if (apiPid) {
      process.kill(apiPid, "SIGTERM");
      await waitForApiShutdown(env.SMOKE_API_URL);
    }
    await new Promise((done) => runtime.close(done));
    await rm(directory, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await verifyActionFixtures();
