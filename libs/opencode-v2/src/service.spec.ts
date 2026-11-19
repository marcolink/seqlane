// @test-scope ./process.ts
// @test-scope ./environment.ts
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { startOpenCodeV2Service } from "./service.js";

async function executable(version = "2.1.2", announce = true) {
  const directory = await mkdtemp(join(tmpdir(), "seqlane-v2-service-"));
  const path = join(directory, "opencode");
  const marker = join(directory, "stopped");
  await writeFile(
    path,
    `#!/usr/bin/env node
import { createServer } from 'node:http'; import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const snapshot = () => JSON.stringify({provider:process.env.SEQLANE_V2_TEST_PROVIDER_KEY ?? null,github:process.env.GITHUB_TOKEN ?? null,aws:process.env.AWS_SECRET_ACCESS_KEY ?? null,npm:process.env.NPM_TOKEN ?? null,path:process.env.PATH});
if (process.argv.includes('--version')) { writeFileSync(${JSON.stringify(join(directory, "version-environment"))},snapshot()); console.log(${JSON.stringify(version)}); process.exit(0); }
writeFileSync(${JSON.stringify(join(directory, "server-environment"))},snapshot());
writeFileSync(${JSON.stringify(join(directory, "shell-environment"))},execFileSync('/bin/sh',['-c','exec "$1" -e "$2"','_',process.execPath,'process.stdout.write((' + snapshot.toString() + ')())']));
const server = createServer((req, res) => {
  const expected = 'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
  if (req.headers.authorization !== expected) { res.writeHead(401); res.end(); return; }
  res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({version:'2.1.2',pid:process.pid,urls:[]}));
});
server.listen(0,'127.0.0.1',()=>{ ${announce ? "console.log('server listening on http://127.0.0.1:' + server.address().port)" : ""} });
process.on('SIGTERM',()=>{writeFileSync(${JSON.stringify(marker)},'stopped');server.close(()=>process.exit(0));});
`,
    { mode: 0o755 },
  );
  return {
    directory,
    path,
    marker,
    close: () => rm(directory, { recursive: true, force: true }),
  };
}
describe("V2 owned service", () => {
  it("excludes unrelated credentials from version probing, the server, and its shell", async () => {
    vi.stubEnv("GITHUB_TOKEN", "unrelated-github-secret");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "unrelated-cloud-secret");
    vi.stubEnv("NPM_TOKEN", "unrelated-package-secret");
    vi.stubEnv("SEQLANE_V2_TEST_PROVIDER_KEY", "selected-provider-secret");
    vi.stubEnv("SEQLANE_OPENCODE_V2_ENV", "SEQLANE_V2_TEST_PROVIDER_KEY");
    const h = await executable();
    let service: Awaited<ReturnType<typeof startOpenCodeV2Service>> | undefined;
    try {
      service = await startOpenCodeV2Service({
        workspace: h.directory,
        executable: h.path,
        signal: AbortSignal.timeout(5000),
      });
      const reportSchema = z.object({
        provider: z.literal("selected-provider-secret"),
        github: z.null(),
        aws: z.null(),
        npm: z.null(),
        path: z.string().min(1),
      });
      for (const name of ["version", "server", "shell"]) {
        const report = reportSchema.parse(
          JSON.parse(
            await readFile(join(h.directory, `${name}-environment`), "utf8"),
          ),
        );
        expect(report.path).toBe(process.env.PATH);
      }
    } finally {
      await service?.close();
      await h.close();
      vi.unstubAllEnvs();
    }
  });
  it("authenticates readiness and closes only its foreground process", async () => {
    const h = await executable();
    try {
      const service = await startOpenCodeV2Service({
        workspace: h.directory,
        executable: h.path,
        signal: AbortSignal.timeout(5000),
      });
      expect(service.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect((await fetch(`${service.url}/api/info`)).status).toBe(401);
      await service.close();
      await service.close();
      expect(await readFile(h.marker, "utf8")).toBe("stopped");
      await expect(fetch(service.url)).rejects.toThrow();
    } finally {
      await h.close();
    }
  });
  it("rejects a V1 binary before starting a server", async () => {
    const h = await executable("1.18.27");
    try {
      await expect(
        startOpenCodeV2Service({
          workspace: h.directory,
          executable: h.path,
          signal: AbortSignal.timeout(5000),
        }),
      ).rejects.toMatchObject({ code: "compatibility" });
      await expect(readFile(h.marker)).rejects.toThrow();
    } finally {
      await h.close();
    }
  });
  it("cancels startup and awaits process cleanup", async () => {
    const h = await executable("2.1.2", false);
    try {
      await expect(
        startOpenCodeV2Service({
          workspace: h.directory,
          executable: h.path,
          signal: AbortSignal.timeout(2000),
        }),
      ).rejects.toThrow("startup");
      expect(await readFile(h.marker, "utf8")).toBe("stopped");
    } finally {
      await h.close();
    }
  });
  it.each([
    { host: "0.0.0.0" },
    { executable: "opencode" },
    { port: -1 },
    { environment: { SEQLANE_OPENCODE_V2_ENV: "*" } },
  ])("rejects invalid service options", async (options) => {
    await expect(
      startOpenCodeV2Service({
        workspace: process.cwd(),
        signal: new AbortController().signal,
        ...options,
      }),
    ).rejects.toThrow();
  });
});
