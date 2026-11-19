// @test-scope ./process.ts
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startOpenCodeV2Service } from "./service.js";

async function executable(version = "2.1.2", announce = true) {
  const directory = await mkdtemp(join(tmpdir(), "seqlane-v2-service-"));
  const path = join(directory, "opencode");
  const marker = join(directory, "stopped");
  await writeFile(
    path,
    `#!/usr/bin/env node
import { createServer } from 'node:http'; import { writeFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log(${JSON.stringify(version)}); process.exit(0); }
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
  it.each([{ host: "0.0.0.0" }, { executable: "opencode" }, { port: -1 }])(
    "rejects invalid service options",
    async (options) => {
      await expect(
        startOpenCodeV2Service({
          workspace: process.cwd(),
          signal: new AbortController().signal,
          ...options,
        }),
      ).rejects.toThrow();
    },
  );
});
