import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = await mkdtemp(join(tmpdir(), "seqlane-action-smoke-"));
const sourceDirectory = join(workspace, "source");
const targetDirectory = join(workspace, "target");
const outputFile = join(workspace, "github-output");
const summaryFile = join(workspace, "github-summary");
let server;
let mutationRequests = 0;
const requests = [];

try {
  await mkdir(sourceDirectory);
  await writeFile(outputFile, "");
  await writeFile(summaryFile, "");
  await execFileAsync("git", [
    "init",
    "--initial-branch=main",
    "-q",
    targetDirectory,
  ]);
  await execFileAsync("git", [
    "-C",
    targetDirectory,
    "config",
    "user.name",
    "Seqlane Smoke",
  ]);
  await execFileAsync("git", [
    "-C",
    targetDirectory,
    "config",
    "user.email",
    "smoke@seqlane.local",
  ]);
  await writeFile(join(targetDirectory, "README.md"), "smoke\n");
  await execFileAsync("git", ["-C", targetDirectory, "add", "--", "README.md"]);
  await execFileAsync("git", ["-C", targetDirectory, "commit", "-qm", "smoke"]);
  const { stdout: revisionOutput } = await execFileAsync("git", [
    "-C",
    targetDirectory,
    "rev-parse",
    "HEAD",
  ]);
  const revision = revisionOutput.trim();

  server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const requestUrl = decodeURIComponent(request.url ?? "");
    if (request.method !== "GET") {
      mutationRequests += 1;
      response.writeHead(405).end();
      return;
    }

    if (requestUrl === "/repos/marcolink/seqlane/pulls/1") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          number: 1,
          state: "open",
          base: {
            ref: "main",
            sha: revision,
            repo: { name: "seqlane", full_name: "marcolink/seqlane" },
          },
          head: {
            ref: "feature/smoke",
            sha: revision,
            repo: { name: "seqlane", full_name: "marcolink/seqlane" },
          },
        }),
      );
      return;
    }

    if (requestUrl === "/repos/marcolink/seqlane/git/ref/heads/main") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          ref: "refs/heads/main",
          object: { sha: revision },
        }),
      );
      return;
    }

    response.writeHead(404).end();
  });
  await new Promise((resolveServer) =>
    server.listen(0, "127.0.0.1", resolveServer),
  );
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The smoke API server did not expose a port.");
  }

  const child = spawn(
    process.execPath,
    [join(repositoryRoot, "actions/resolve-merge-conflicts/dist/main.js")],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        "INPUT_PULL-REQUEST-NUMBER": "1",
        "INPUT_RESOLUTION-STRATEGY": "rebase",
        "INPUT_SOURCE-DIRECTORY": "source",
        "INPUT_TARGET-DIRECTORY": "target",
        INPUT_COMMIT: "false",
        INPUT_PUSH: "false",
        "INPUT_MAX-ATTEMPTS": "10",
        GITHUB_ACTIONS: "true",
        GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
        GITHUB_REPOSITORY: "marcolink/seqlane",
        GITHUB_WORKSPACE: workspace,
        GITHUB_WORKFLOW_REF: "marcolink/seqlane/.github/workflows/ci.yml@main",
        GITHUB_WORKFLOW_SHA: revision,
        GITHUB_TOKEN: "local-smoke-token",
        GH_TOKEN: "local-smoke-token",
        OPENAI_API_KEY: "local-smoke-key",
        GITHUB_OUTPUT: outputFile,
        GITHUB_STEP_SUMMARY: summaryFile,
        RUNNER_TEMP: workspace,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exitCode = await new Promise((resolveChild, rejectChild) => {
    child.once("error", rejectChild);
    child.once("exit", (code) => resolveChild(code ?? 1));
  });
  if (exitCode !== 0) {
    const summary = await readFile(summaryFile, "utf8");
    throw new Error(
      `Action smoke exited with ${exitCode}.\n${stdout}\n${stderr}\n${summary}\nRequests: ${requests.join(", ")}`,
    );
  }
  if (mutationRequests !== 0) {
    throw new Error("The Action smoke attempted a remote mutation.");
  }
  const output = await readFile(outputFile, "utf8");
  if (!output.includes("result<<")) {
    throw new Error("The Action smoke did not write its result output.");
  }
  console.log("Action entrypoint smoke passed with commit and push disabled.");
} finally {
  if (server !== undefined)
    await new Promise((resolveServer) => server.close(resolveServer));
  await rm(workspace, { recursive: true, force: true });
}
