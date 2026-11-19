// Hosted-runner fixtures: no model calls, publication writes, or remote Git writes.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
const root = resolve(process.env.RUNNER_TEMP ?? "/tmp", "seqlane-action-smoke");
const metadataPath = join(root, "metadata.json");
const requestPath = join(root, "requests.jsonl");

async function listen(server, port = 0) {
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

if (mode === "api") {
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  const server = createServer((request, response) => {
    appendFileSync(
      requestPath,
      JSON.stringify({ method: request.method, url: request.url }) + "\n",
    );
    response.setHeader("Content-Type", "application/json");
    const prefix = `/repos/${metadata.repository}`;
    let path;
    try {
      path = decodeURIComponent(
        new URL(request.url, "http://localhost").pathname,
      );
    } catch {
      response.writeHead(400).end(JSON.stringify({ message: "Invalid route" }));
      return;
    }
    let body;
    if (request.method === "GET" && path === `${prefix}/pulls/1`) {
      body = { ...metadata.pullRequest, number: 1, state: "closed" };
    } else if (
      request.method === "GET" &&
      path === `${prefix}/issues/1/comments`
    ) {
      body = [];
    } else if (request.method === "GET" && path === `${prefix}/pulls/2`) {
      body = { ...metadata.pullRequest, number: 2 };
    } else if (
      request.method === "GET" &&
      path === `${prefix}/git/ref/heads/main`
    ) {
      body = { ref: "refs/heads/main", object: { sha: metadata.sha } };
    } else {
      response.statusCode = 403;
      body = { message: "Hosted fixture denies this operation" };
    }
    response.end(JSON.stringify(body));
  });
  const port = await listen(server);
  process.send({ port });
  process.disconnect();
} else if (mode === "service") {
  const args = process.argv.slice(3);
  if (args.includes("status")) {
    const response = await fetch(process.env.SMOKE_ZVEC_URL, {
      signal: AbortSignal.timeout(2_000),
    });
    assert.equal(response.status, 200);
  } else if (args.includes("serve") || args.includes("run")) {
    const port = Number(args[args.indexOf("--port") + 1] ?? 0);
    const address = args[args.indexOf("--listen") + 1];
    const targetPort = args.includes("--listen")
      ? Number(address.split(":").at(-1))
      : port;
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({ healthy: true, version: "hosted-fixture" }),
      );
    });
    await listen(server, targetPort);
  } else {
    assert(
      args.includes("version") || args.includes("index"),
      "Unexpected fixture command",
    );
  }
} else if (mode === "prepare") {
  mkdirSync(root, { recursive: true });
  const source = join(root, "source");
  mkdirSync(source, { recursive: true });
  writeFileSync(
    join(source, "package.json"),
    JSON.stringify({ name: "hosted-action-fixture", private: true }),
  );
  const target = join(root, "target");
  mkdirSync(target, { recursive: true });
  const git = (...args) =>
    execFileSync("git", args, { cwd: target, encoding: "utf8" }).trim();
  git("init", "--initial-branch=main");
  git("config", "user.name", "Action fixture");
  git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(target, "fixture.txt"), "clean\n");
  git("add", "fixture.txt");
  git("commit", "-m", "fixture");
  const sha = git("rev-parse", "HEAD");
  const repository = process.env.GITHUB_REPOSITORY;
  assert(repository?.includes("/"));
  const [owner, name] = repository.split("/");
  const repo = { name, full_name: repository, owner: { login: owner } };
  writeFileSync(
    metadataPath,
    JSON.stringify({
      repository,
      sha,
      pullRequest: {
        title: "Hosted fixture",
        body: "No model or publication required",
        state: "open",
        draft: false,
        base: { ref: "main", sha, repo },
        head: { ref: "fixture", sha, repo },
      },
    }),
  );
  writeFileSync(requestPath, "");
  const script = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [script, "api"], {
    detached: true,
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const [{ port }] = await once(child, "message", {
    signal: AbortSignal.timeout(10_000),
  });
  child.unref();
  const apiUrl = `http://127.0.0.1:${port}`;
  const apiPreload = join(root, "github-api.cjs");
  // The runner restores reserved GITHUB_* variables before JavaScript Actions.
  // Restore the fixture endpoint and workspace before Actions Toolkit loads.
  // Resolver directory inputs remain relative to that root and do not overlap.
  writeFileSync(
    apiPreload,
    `process.env.GITHUB_API_URL = ${JSON.stringify(apiUrl)};\n` +
      `process.env.GITHUB_WORKSPACE = ${JSON.stringify(root)};\n`,
  );
  const freePort = async () => {
    const server = createServer();
    const value = await listen(server);
    await new Promise((done) => server.close(done));
    return value;
  };
  const openCodePort = await freePort();
  const zvecPort = await freePort();
  const executable = join(root, "service.cjs");
  writeFileSync(
    executable,
    `#!/usr/bin/env node\nprocess.argv.splice(2, 0, "service"); import(${JSON.stringify(import.meta.url)});\n`,
    { mode: 0o755 },
  );
  const values = {
    SMOKE_TARGET: target,
    SMOKE_WORKSPACE: root,
    SMOKE_SOURCE_DIRECTORY: "source",
    SMOKE_TARGET_DIRECTORY: "target",
    SMOKE_SHA: sha,
    SMOKE_EXECUTABLE: executable,
    SMOKE_API_URL: apiUrl,
    SMOKE_API_PRELOAD: apiPreload,
    SMOKE_API_PID: child.pid,
    SMOKE_OPENCODE_PORT: openCodePort,
    SMOKE_ZVEC_LISTEN: `127.0.0.1:${zvecPort}`,
    SMOKE_ZVEC_URL: `http://127.0.0.1:${zvecPort}/mcp`,
  };
  appendFileSync(
    process.env.GITHUB_ENV,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
} else if (mode === "verify") {
  assert.equal(process.env.SMOKE_REVIEW_VERDICT, "stale");
  assert.equal(process.env.SMOKE_REVIEW_PUBLICATION, "stale");
  assert.equal(process.env.SMOKE_CONFLICT_RESULT, "no-change");
  assert.equal(process.env.SMOKE_CONFLICT_PUSHED, "false");
  for (const url of [
    process.env.SMOKE_OPENCODE_URL,
    process.env.SMOKE_ZVEC_URL,
  ]) {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    assert.equal(response.status, 200);
  }
  const requests = readFileSync(requestPath, "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert(requests.length >= 5);
  assert(
    requests.every(({ method }) => method === "GET"),
    "Fixture observed a write attempt",
  );
  assert.equal(
    execFileSync("git", ["status", "--porcelain"], {
      cwd: process.env.SMOKE_TARGET,
      encoding: "utf8",
    }).trim(),
    "",
  );
  console.log(
    "Hosted Action outputs, surviving services, stale review, clean Git integration, and zero writes confirmed.",
  );
  process.kill(Number(process.env.SMOKE_API_PID), "SIGTERM");
} else {
  throw new Error("Expected prepare, api, service, or verify");
}
