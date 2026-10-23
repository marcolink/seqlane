import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  outputFields,
  verifyActionFixtures,
} from "./verify-action-fixtures.mjs";

const run = promisify(execFile);
const repository = resolve(import.meta.dirname, "..");
const directory = await mkdtemp(join(tmpdir(), "seqlane-bundled-lifetimes-"));
const foreign = spawn(
  process.execPath,
  ["-e", "setInterval(() => {}, 60000)"],
  { stdio: "ignore" },
);
await once(foreign, "spawn");
const cleanupPosts = [];

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function entrypoint(action, name, env) {
  return run(
    process.execPath,
    [join(repository, "actions", action, "dist", name)],
    {
      cwd: directory,
      env,
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
}

try {
  await writeFile(
    join(directory, "fixture.ts"),
    "export function identity(value: string) { return value; }\n",
  );
  const executable = join(directory, "service.cjs");
  await writeFile(
    executable,
    `#!/usr/bin/env node\nprocess.argv.splice(2, 0, "service"); import(${JSON.stringify(new URL("./action-hosted-smoke.mjs", import.meta.url).href)});\n`,
    { mode: 0o755 },
  );
  for (const action of [
    "opencode-server",
    "zvec-grep-server",
    "ripwire-server",
  ]) {
    const temp = join(directory, action);
    await mkdir(temp);
    const statePath = join(temp, "state");
    const outputPath = join(temp, "output");
    await writeFile(statePath, "");
    await writeFile(outputPath, "");
    const port = await freePort();
    const env = {
      ...process.env,
      NODE_ENV: "production",
      GITHUB_STATE: statePath,
      GITHUB_OUTPUT: outputPath,
      RUNNER_TEMP: temp,
      "INPUT_WORKING-DIRECTORY": directory,
      "INPUT_STARTUP-TIMEOUT-SECONDS": "60",
      INPUT_EXECUTABLE: executable,
      INPUT_HOSTNAME: "127.0.0.1",
      INPUT_PORT: String(port),
      "INPUT_PACKAGE-MANAGER": executable,
      "INPUT_MODEL-CACHE": "false",
      INPUT_LISTEN: `127.0.0.1:${port}`,
      SMOKE_ZVEC_URL: `http://127.0.0.1:${port}/mcp`,
    };
    // Fixture child services and package installation never receive publication credentials.
    for (const key of [
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "OPENAI_API_KEY",
      "INPUT_PUSH-TOKEN",
    ])
      delete env[key];
    let startupFailure;
    try {
      await entrypoint(action, "main.js", env);
    } catch (cause) {
      startupFailure = cause;
    }
    const state = outputFields(await readFile(statePath, "utf8"));
    const outputs = outputFields(await readFile(outputPath, "utf8"));
    const postEnv = {
      ...env,
      ...Object.fromEntries(
        Object.entries(state).map(([key, value]) => [`STATE_${key}`, value]),
      ),
    };
    const cleanup = () => entrypoint(action, "post.js", postEnv);
    cleanupPosts.push(cleanup);
    if (startupFailure !== undefined) throw startupFailure;
    const url = outputs.url ?? outputs["mcp-url"];
    assert(url, `${action} omitted its endpoint`);
    const headers = outputs["mcp-token"]
      ? { Authorization: `Bearer ${outputs["mcp-token"]}` }
      : {};
    // Any HTTP response proves the listener survives the completed main process.
    await fetch(url, { headers, signal: AbortSignal.timeout(2_000) }).then(
      (response) => response.body?.cancel(),
    );
    const post = await cleanup();
    assert.match(
      post.stdout,
      /stopped cleanly/,
      `${action} did not confirm cleanup: ${post.stdout}\n${post.stderr}`,
    );
    await assert.rejects(
      fetch(url, { signal: AbortSignal.timeout(2_000) }),
      `${action} listener survived post`,
    );
    process.kill(foreign.pid, 0);
    cleanupPosts.pop();
    console.log(
      `${action}: main exited, resident survived, post confirmed stop, listener gone, foreign process alive.`,
    );
  }
} finally {
  for (const cleanup of cleanupPosts.reverse())
    await cleanup().catch(() => undefined);
  foreign.kill("SIGTERM");
  if (foreign.exitCode === null && foreign.signalCode === null)
    await once(foreign, "exit");
  await rm(directory, { recursive: true, force: true });
}

await verifyActionFixtures();
