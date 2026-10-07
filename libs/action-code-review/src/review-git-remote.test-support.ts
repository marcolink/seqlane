import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:https";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const exec = promisify(execFile);

/** Native Git HTTPS fixture; no custom Git protocol implementation. */
export async function createReviewGitRemote(cwd: string) {
  const root = await mkdtemp(join(tmpdir(), "seqlane-review-remote-"));
  const path = join(root, "repo.git");
  const certificate = join(root, "cert.pem");
  const key = join(root, "key.pem");
  const authorization: (string | undefined)[] = [];
  const run = async (...argv: string[]) =>
    (await exec("git", ["--git-dir", path, ...argv])).stdout.trim();
  await exec("git", ["clone", "--bare", cwd, path]);
  await exec("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    certificate,
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);
  const server = createServer(
    { key: await readFile(key), cert: await readFile(certificate) },
    (request, response) => {
      authorization.push(request.headers.authorization);
      const url = new URL(request.url ?? "", "https://localhost");
      const backend = spawn("git", ["http-backend"], {
        env: {
          PATH: process.env.PATH,
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: request.method,
          CONTENT_TYPE: String(request.headers["content-type"] ?? ""),
          HTTP_GIT_PROTOCOL: String(request.headers["git-protocol"] ?? ""),
        },
      });
      request.pipe(backend.stdin);
      backend.stdin.on("error", () => backend.kill());
      request.on("aborted", () => backend.kill());
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
        for (const header of bytes
          .subarray(0, separator)
          .toString()
          .split("\r\n")) {
          const index = header.indexOf(":");
          if (index > 0 && header.slice(0, index).toLowerCase() !== "status")
            response.setHeader(
              header.slice(0, index),
              header.slice(index + 1).trim(),
            );
        }
        response.end(bytes.subarray(separator + 4));
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = z.object({ port: z.number() }).parse(server.address()).port;
  return {
    run,
    certificate,
    authorization,
    url: `https://127.0.0.1:${port}/repo.git`,
    dispose: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(root, { recursive: true, force: true });
    },
  };
}
