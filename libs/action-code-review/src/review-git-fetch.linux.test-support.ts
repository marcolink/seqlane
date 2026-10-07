import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { createServer } from "node:https";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { admitReviewScopeWithGitHost } from "./review-git-host-admission.js";
import { createReviewStateFixture } from "./review-state-fixture.test-support.js";
import { encodeReviewStateV5 } from "./review-state-codec.js";
import { z } from "zod";
import { createReviewGitHost } from "./review-git-host.js";
import {
  reviewGitResultSchema,
  type ReviewGitRequest,
} from "./review-git-budget.js";

const exec = promisify(execFile);

/** Disposable HTTPS git-http-backend fixture. No remote GitHub mutation. */
export async function verifyReviewGitFetch(cwd: string, cgroupRoot: string) {
  const root = await mkdtemp(join(tmpdir(), "seqlane-git-remote-"));
  const remotePath = join(root, "repo.git");
  const run = async (...args: string[]) =>
    (await exec("/usr/bin/git", args)).stdout.trim();
  await run("clone", "--bare", cwd, remotePath);
  await run("--git-dir", remotePath, "config", "user.name", "Fixture");
  await run(
    "--git-dir",
    remotePath,
    "config",
    "user.email",
    "review@example.test",
  );
  const tree = await run("-C", cwd, "rev-parse", "HEAD^{tree}");
  const base = await run("-C", cwd, "rev-list", "--max-parents=0", "HEAD");
  const revision = await run(
    "--git-dir",
    remotePath,
    "commit-tree",
    tree,
    "-p",
    base,
    "-m",
    "Published checkpoint",
  );
  await run(
    "--git-dir",
    remotePath,
    "update-ref",
    "refs/heads/published",
    revision,
  );
  const keyPath = join(root, "key.pem");
  const certPath = join(root, "cert.pem");
  await exec("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);
  const ca = await readFile(certPath);
  const requests: string[] = [];
  let sentBytes = 0;
  let mode: "git" | "oversized" | "redirect" | "stall" = "git";
  const server = createServer(
    { key: await readFile(keyPath), cert: ca },
    (request, response) => {
      requests.push(request.url ?? "");
      if (mode === "redirect") {
        response.writeHead(302, { Location: "https://example.invalid/leak" });
        response.end();
        return;
      }
      if (mode === "stall") return;
      if (mode === "oversized") {
        response.writeHead(200, {
          "Content-Type": "application/x-git-upload-pack-advertisement",
        });
        response.end(randomBytes(4096));
        return;
      }
      const url = new URL(request.url ?? "", "https://localhost");
      const backend = spawn("/usr/bin/git", ["http-backend"], {
        env: {
          PATH: "/usr/bin:/bin",
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: request.method ?? "GET",
          CONTENT_TYPE: String(request.headers["content-type"] ?? ""),
          REMOTE_ADDR: "127.0.0.1",
          SERVER_PROTOCOL: "HTTP/1.1",
        },
        stdio: ["pipe", "pipe", "ignore"],
      });
      request.pipe(backend.stdin);
      backend.stdin.on("error", () => undefined);
      const chunks: Buffer[] = [];
      backend.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      backend.on("close", () => {
        const bytes = Buffer.concat(chunks);
        const separator = bytes.indexOf("\r\n\r\n");
        if (separator < 0) {
          response.writeHead(500);
          response.end();
          return;
        }
        const headers = bytes.subarray(0, separator).toString().split("\r\n");
        for (const header of headers) {
          const index = header.indexOf(":");
          if (index > 0 && header.slice(0, index).toLowerCase() !== "status")
            response.setHeader(
              header.slice(0, index),
              header.slice(index + 1).trim(),
            );
        }
        const body = bytes.subarray(separator + 4);
        sentBytes += body.byteLength;
        response.end(body);
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  // Node platform interop: a listening TCP server returns AddressInfo.
  const port = z
    .object({ port: z.number().int().positive() })
    .parse(address).port;
  const oldCa = getCACertificates("default");
  setDefaultCACertificates([...oldCa, ca]);
  const host = await createReviewGitHost({
    reviewTarget: cwd,
    cgroupRoot,
    trustedRemote: {
      url: `https://127.0.0.1:${port}/repo.git`,
      authorization: "Bearer fixture-secret",
    },
  });
  const limits = {
    wallMs: 3000,
    cpuMs: 2000,
    peakMemoryBytes: 64 * 1024 * 1024,
    outputBytes: 65_536,
    transferBytes: 1_000_000,
  };
  const request: ReviewGitRequest = { argv: ["--no-replace-objects"], limits };
  try {
    assert.notEqual(
      (
        await exec("/usr/bin/git", [
          "-C",
          cwd,
          "cat-file",
          "-t",
          revision,
        ]).catch(() => ({ stdout: "absent" }))
      ).stdout.trim(),
      "commit",
    );
    const head = await run("-C", cwd, "rev-parse", "HEAD");
    await run(
      "-C",
      cwd,
      "config",
      "url.https://example.invalid/.insteadOf",
      "https://127.0.0.1/",
    );
    const state = encodeReviewStateV5(createReviewStateFixture(base, revision));
    const admitted = await admitReviewScopeWithGitHost(
      {
        pullRequest: {
          repositoryId: "1",
          pullRequestNumber: 112,
          targetBranch: "release",
          baseRevision: base,
          headRevision: head,
        },
      },
      {
        reviewTarget: cwd,
        cgroupRoot,
        trustedRemote: {
          url: `https://127.0.0.1:${port}/repo.git`,
          authorization: "Bearer fixture-secret",
        },
      },
      () => ({
        listIssueComments: async () => ({
          items: [
            {
              id: 42,
              user: { login: "github-actions[bot]" },
              author_association: "NONE",
              body: state,
              created_at: "2026-10-07",
              updated_at: "2026-10-07",
            },
          ],
          hasNextPage: false,
        }),
      }),
    );
    assert.equal(admitted.scopeIdentity.mode, "incremental");
    assert.equal(admitted.scopeIdentity.checkpointRevision, revision);
    assert.deepEqual(admitted.evidence.reviewablePaths, []);
    assert.equal(await run("-C", cwd, "rev-parse", "HEAD"), head);
    assert.equal(requests.length, 2); // One exact fetch, no branch fallback or retry.
    requests.length = 0;
    sentBytes = 0;
    const fetched = reviewGitResultSchema.parse(
      await host.git.fetchExactCommit?.(revision, request),
    );
    assert.equal(fetched.exitCode, 0);
    assert.equal(fetched.usage.transferBytes, sentBytes);
    assert.ok(sentBytes > 0);
    assert.equal(await run("-C", cwd, "cat-file", "-t", revision), "commit");
    assert.equal(await run("-C", cwd, "rev-parse", "HEAD"), head);
    assert.deepEqual(requests, [
      "/repo.git/info/refs?service=git-upload-pack",
      "/repo.git/git-upload-pack",
    ]);
    mode = "oversized";
    await assert.rejects(
      host.git.fetchExactCommit?.(revision, {
        ...request,
        limits: { ...limits, transferBytes: 1024 },
      }) ?? Promise.resolve(),
      { resource: "transferBytes", limit: 1024 },
    );
    mode = "redirect";
    await assert.rejects(
      host.git.fetchExactCommit?.(revision, request) ?? Promise.resolve(),
      { code: "CHECKPOINT_UNAVAILABLE" },
    );
    mode = "stall";
    await assert.rejects(
      host.git.fetchExactCommit?.(revision, {
        ...request,
        limits: { ...limits, wallMs: 100 },
      }) ?? Promise.resolve(),
      { resource: "commandWallMs" },
    );
    const cancellation = new AbortController();
    const stopped =
      host.git.fetchExactCommit?.(revision, {
        ...request,
        signal: cancellation.signal,
      }) ?? Promise.resolve();
    setTimeout(() => cancellation.abort(), 50);
    await assert.rejects(stopped, { code: "REVIEW_SCOPE_CANCELLED" });
    mode = "git";
    await assert.rejects(
      host.git.fetchExactCommit?.("a".repeat(revision.length), request) ??
        Promise.resolve(),
      { code: "CHECKPOINT_UNAVAILABLE" },
    );
  } finally {
    await host.close();
    setDefaultCACertificates(oldCa);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}
