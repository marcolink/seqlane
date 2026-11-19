// @test-scope ./docker-cli.ts
// @test-scope ./docker-container.ts
// @test-scope ./lockfile-docker.ts
// @test-scope ./generated-file-handler.ts

import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";

import { NodeLockfileRegenerator } from "./lockfile-docker.js";
import { NodeGeneratedFileHandler } from "./generated-file-handler.js";
import { DockerCleanupUnconfirmedError } from "./docker-container.js";
import type { GitWorkspacePort } from "./git-port.js";
import { dockerCliEffect } from "./docker-cli.js";

type FixtureMode =
  | "success"
  | "cancel"
  | "uncertain"
  | "foreign"
  | "malformed"
  | "overflow"
  | "late-create";

async function fixture(mode: FixtureMode) {
  const root = await mkdtemp(join(tmpdir(), "seqlane-docker-owned-"));
  const source = join(root, "source");
  const target = join(root, "target");
  const temporaryParent = join(root, "temporary");
  await Promise.all([mkdir(source), mkdir(target), mkdir(temporaryParent)]);
  await writeFile(
    join(source, "package.json"),
    '{"packageManager":"pnpm@10.33.0"}',
  );
  await writeFile(join(target, "package.json"), "{}");
  await writeFile(join(target, "pnpm-lock.yaml"), "old");
  const daemon = join(root, "daemon.mjs");
  const executable = join(root, "docker");
  await writeFile(
    daemon,
    `
import fs from "node:fs";
import path from "node:path";
const root = ${JSON.stringify(root)};
const state = JSON.parse(fs.readFileSync(path.join(root, "container.json"), "utf8"));
const marker = path.join(root, "alive");
fs.writeFileSync(marker, String(process.pid));
const write = () => fs.writeFileSync(path.join(state.workspace, "pnpm-lock.yaml"), "generated");
const stop = () => { clearInterval(writes); fs.rmSync(marker, {force:true}); process.exit(0); };
process.on("SIGTERM", stop);
const writes = setInterval(write, 10);
write();
if (${JSON.stringify(mode)} === "success") setTimeout(stop, 80);
`,
  );
  await writeFile(
    executable,
    `#!${process.execPath}
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
const root = ${JSON.stringify(root)};
const mode = ${JSON.stringify(mode)};
const args = process.argv.slice(2);
const file = path.join(root, "container.json");
const id = "a".repeat(64);
const foreignId = "b".repeat(64);
const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
const save = state => fs.writeFileSync(file, JSON.stringify(state));
const event = (name, state) => fs.appendFileSync(path.join(root, "events"), JSON.stringify({name, id:state?.id, workspaceExists:state ? fs.existsSync(state.workspace) : undefined}) + "\\n");
const value = flag => args[args.indexOf(flag)+1];
if (args[1] === "create") {
 const mount = args.find(arg=>arg.endsWith(",target=/workspace"));
 const workspace = mount.match(/source=(.*),target=/)[1];
 const label = value("--label").split("=");
 const state = { id:mode === "foreign" ? foreignId : id, name:value("--name"), label:label[0], token:mode === "foreign" ? "foreign" : label[1], workspace, running:false, exitCode:0 };
 if(mode === "late-create") {
   const delayed = spawn(${JSON.stringify(process.execPath)}, ["-e", 'const fs=require("node:fs");let count=0;const poll=setInterval(()=>{if(fs.existsSync(process.argv[3])){clearInterval(poll);setTimeout(()=>fs.writeFileSync(process.argv[1],process.argv[2]),100)}else if(++count>500)process.exit(1)},10)', file, JSON.stringify(state), path.join(root,"readback")], {detached:true,stdio:"ignore"});
   delayed.unref();
   process.on("SIGTERM",()=>{ event("client-exit",state); process.exit(1); });
   fs.writeFileSync(path.join(root,"ready"),"ready");
   await delay(10000);
 }
 save(state);
 fs.writeFileSync(path.join(root,"environment"), JSON.stringify(process.env));
 event("create", state);
 if (mode === "foreign") process.exit(1);
 console.log(id);
} else if (args[1] === "inspect") {
 const state = read();
 if(mode === "malformed") { console.log("[{malformed]"); process.exit(0); }
 if(args[2] !== state.id) process.exit(1);
 console.log(JSON.stringify([{Id:state.id,Config:{Labels:{[state.label]:state.token}},State:{Running:state.running,ExitCode:state.exitCode}}]));
} else if (args[1] === "start") {
 let state = read();
 const daemon = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(daemon)}], {detached:true,stdio:"ignore"});
 daemon.unref();
 state.pid = daemon.pid; state.running = true; save(state);
 while(!fs.existsSync(path.join(root,"alive"))) await delay(5);
 fs.writeFileSync(path.join(root,"ready"),"ready");
 process.on("SIGTERM", () => { event("client-term", state); setTimeout(()=>{ event("client-exit",state); process.exit(1); }, 70); });
 if(mode === "overflow") process.stdout.write("x".repeat(8*1024*1024+1));
 while(fs.existsSync(path.join(root,"alive"))) await delay(10);
 state.running = false; save(state); event("client-exit",state);
} else if (args[1] === "ls") {
 if(mode === "late-create" && !fs.existsSync(file)) fs.writeFileSync(path.join(root,"readback"),"readback");
 if(fs.existsSync(file)) console.log(read().id);
} else if (args[1] === "rm") {
 const state = read();
 event("remove",state);
 if(args.at(-1) !== id || state.id !== id) throw new Error("foreign container removal attempted");
 if(mode === "uncertain") process.exit(1);
 if(state.pid) {
   try { process.kill(state.pid,"SIGTERM"); } catch (error) { if(error.code !== "ESRCH") throw error; }
   while(fs.existsSync(path.join(root,"alive"))) await delay(5);
 }
 event("container-stopped",state);
 fs.rmSync(file);
} else { throw new Error("unexpected Docker command " + args.join(" ")); }
`,
  );
  await chmod(executable, 0o700);
  const git: GitWorkspacePort = {
    cwd: target,
    run: async (args) => ({
      executable: "git",
      args,
      cwd: target,
      exitCode: 0,
      stdout: args[0] === "ls-files" ? "package.json\0" : "",
      stderr: "",
    }),
  };
  const cleanup = async () => {
    try {
      const pid = Number(await readFile(join(root, "alive"), "utf8"));
      process.kill(pid, "SIGTERM");
      await vi.waitFor(async () => {
        await expect(readFile(join(root, "alive"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      });
    } catch {
      /* The confirmed-cleanup cases have no remaining daemon. */
    }
    await rm(root, { recursive: true, force: true });
  };
  const regenerator = (
    signal?: AbortSignal,
    timeoutMs?: number,
    onUncertain?: (cause: unknown) => void,
  ) =>
    new NodeLockfileRegenerator({
      targetRoot: target,
      trustedSourceRoot: source,
      temporaryParent,
      git,
      dockerExecutable: executable,
      env: { GITHUB_TOKEN: "must-not-inherit", SECRET: "must-not-inherit" },
      signal,
      timeoutMs,
      onUncertain,
    });
  const ready = () =>
    vi.waitFor(async () =>
      expect(await readFile(join(root, "ready"), "utf8")).toBe("ready"),
    );
  const events = () => readFile(join(root, "events"), "utf8");
  return {
    root,
    source,
    target,
    temporaryParent,
    executable,
    git,
    cleanup,
    regenerator,
    ready,
    events,
  };
}

describe("owned Docker regeneration through the real caller", () => {
  it("reports unacknowledged create as uncertain even when the first daemon read is empty", async () => {
    const test = await fixture("late-create");
    const controller = new AbortController();
    const onUncertain = vi.fn();
    try {
      const running = test
        .regenerator(controller.signal, undefined, onUncertain)
        .regenerate();
      const failed = expect(running).rejects.toBeInstanceOf(
        DockerCleanupUnconfirmedError,
      );
      await test.ready();
      controller.abort();
      await failed;
      expect(await readdir(test.temporaryParent)).toHaveLength(1);
      expect(onUncertain).toHaveBeenCalledOnce();
      await vi.waitFor(async () =>
        expect(
          await readFile(join(test.root, "container.json"), "utf8"),
        ).toContain('"running":false'),
      );
      const diagnostic = onUncertain.mock.calls[0]?.[0];
      expect(diagnostic).toBeInstanceOf(AggregateError);
      if (!(diagnostic instanceof AggregateError))
        throw new Error("Missing cleanup diagnostic");
      expect(diagnostic.errors.at(-1)).toHaveProperty(
        "cause.containerName",
        expect.stringMatching(/^seqlane-generated-/),
      );
      expect(diagnostic.errors.at(-1)).toHaveProperty(
        "cause.ownerToken",
        expect.any(String),
      );
      expect(await test.events()).not.toContain('"name":"container-stopped"');
    } finally {
      await test.cleanup();
    }
  });

  it("uses the same stop-before-delete rule through the generated-file handler", async () => {
    const test = await fixture("cancel");
    const controller = new AbortController();
    try {
      const handler = new NodeGeneratedFileHandler({
        targetRoot: test.target,
        temporaryParent: test.temporaryParent,
        git: test.git,
        dockerExecutable: test.executable,
        signal: controller.signal,
      });
      const running = handler.run(
        {
          match: "output.txt",
          outputs: ["output.txt"],
          handler: { command: ["generate"] },
        },
        [{ path: "output.txt", stage: 2 }],
      );
      const failed = expect(running).rejects.toMatchObject({
        code: "CONFLICT_HANDLER_FAILED",
      });
      await test.ready();
      controller.abort();
      await failed;
      expect(await readdir(test.temporaryParent)).toEqual([]);
      expect(await test.events()).toContain(
        '"name":"container-stopped","id":"' +
          "a".repeat(64) +
          '","workspaceExists":true',
      );
    } finally {
      await test.cleanup();
    }
  });

  it("copies only after the daemon stopped and removes the owned container", async () => {
    const test = await fixture("success");
    try {
      await test.regenerator().regenerate();
      expect(await readFile(join(test.target, "pnpm-lock.yaml"), "utf8")).toBe(
        "generated",
      );
      expect(await readdir(test.temporaryParent)).toEqual([]);
      expect(await test.events()).toContain(
        '"name":"container-stopped","id":"' +
          "a".repeat(64) +
          '","workspaceExists":true',
      );
      const environment = await readFile(
        join(test.root, "environment"),
        "utf8",
      );
      expect(environment).not.toContain("GITHUB_TOKEN");
      expect(environment).not.toContain("SECRET");
    } finally {
      await test.cleanup();
    }
  });

  it.each(["abort", "deadline", "overflow"] as const)(
    "drains the client and stops late container writes on %s before deleting files",
    async (trigger) => {
      const test = await fixture(
        trigger === "overflow" ? "overflow" : "cancel",
      );
      const controller = new AbortController();
      try {
        const running = test
          .regenerator(
            controller.signal,
            trigger === "deadline" ? 1_000 : undefined,
          )
          .regenerate();
        const failed = expect(running).rejects.toMatchObject({
          code: "LOCKFILE_REGENERATION_FAILED",
        });
        await test.ready();
        if (trigger === "abort") controller.abort();
        await failed;
        expect(await readdir(test.temporaryParent)).toEqual([]);
        expect(
          await readFile(join(test.target, "pnpm-lock.yaml"), "utf8"),
        ).toBe("old");
        const events = await test.events();
        expect(events.indexOf('"name":"client-exit"')).toBeLessThan(
          events.indexOf('"name":"remove"'),
        );
        expect(events).toContain(
          '"name":"container-stopped","id":"' +
            "a".repeat(64) +
            '","workspaceExists":true',
        );
        await delay(80);
        expect(await readdir(test.temporaryParent)).toEqual([]);
      } finally {
        await test.cleanup();
      }
    },
    15_000,
  );

  it("retains the workspace and reports unconfirmed daemon cleanup", async () => {
    const test = await fixture("uncertain");
    const controller = new AbortController();
    const onUncertain = vi.fn();
    try {
      const running = test
        .regenerator(controller.signal, undefined, onUncertain)
        .regenerate();
      const failed = expect(running).rejects.toBeInstanceOf(
        DockerCleanupUnconfirmedError,
      );
      await test.ready();
      controller.abort();
      await failed;
      expect(await readdir(test.temporaryParent)).toHaveLength(1);
      expect(onUncertain).toHaveBeenCalledOnce();
      expect(await readFile(join(test.root, "alive"), "utf8")).toMatch(/^\d+$/);
    } finally {
      await test.cleanup();
    }
  });

  it("never removes a foreign container after a name collision", async () => {
    const test = await fixture("foreign");
    try {
      await expect(test.regenerator().regenerate()).rejects.toMatchObject({
        code: "LOCKFILE_REGENERATION_FAILED",
      });
      expect(
        await readFile(join(test.root, "container.json"), "utf8"),
      ).toContain('"token":"foreign"');
      expect(await test.events()).not.toContain('"name":"remove"');
      expect(await readdir(test.temporaryParent)).toEqual([]);
    } finally {
      await test.cleanup();
    }
  });

  it("retains files when Docker identity output is malformed", async () => {
    const test = await fixture("malformed");
    try {
      await expect(test.regenerator().regenerate()).rejects.toBeInstanceOf(
        DockerCleanupUnconfirmedError,
      );
      expect(await test.events()).not.toContain('"name":"remove"');
      expect(await readdir(test.temporaryParent)).toHaveLength(1);
    } finally {
      await test.cleanup();
    }
  });
});

describe("Docker cleanup compatibility", () => {
  it("allows 8 MiB separately for stdout and stderr", async () => {
    const test = await fixture("foreign");
    try {
      const result = await Effect.runPromise(
        dockerCliEffect(
          {
            executable: process.execPath,
            args: [
              "-e",
              'process.stdout.write("x".repeat(5*1024*1024)); process.stderr.write("y".repeat(5*1024*1024));',
            ],
            cwd: test.root,
            env: {},
          },
          {},
        ),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toHaveLength(5 * 1024 * 1024);
      expect(result.stderr).toHaveLength(5 * 1024 * 1024);
    } finally {
      await test.cleanup();
    }
  });

  it.each([undefined, null, false, 0, ""])(
    "retains falsey cleanup causes and both consumer workspaces: %s",
    async (cause) => {
      const test = await fixture("foreign");
      const failure = new DockerCleanupUnconfirmedError(cause);
      const docker = {
        run: async () => {
          throw failure;
        },
      };
      try {
        await expect(
          new NodeLockfileRegenerator({
            targetRoot: test.target,
            trustedSourceRoot: test.source,
            temporaryParent: test.temporaryParent,
            git: test.git,
            docker,
          }).regenerate(),
        ).rejects.toMatchObject({ cause: failure });
        await expect(
          new NodeGeneratedFileHandler({
            targetRoot: test.target,
            temporaryParent: test.temporaryParent,
            git: test.git,
            docker,
          }).run(
            {
              match: "output.txt",
              outputs: ["output.txt"],
              handler: { command: ["generate"] },
            },
            [{ path: "output.txt", stage: 2 }],
          ),
        ).rejects.toMatchObject({
          code: "CONFLICT_HANDLER_FAILED",
          cause: { cause: failure },
        });
        expect(failure.cause).toBe(cause);
        expect(await readdir(test.temporaryParent)).toHaveLength(2);
      } finally {
        await test.cleanup();
      }
    },
  );
});
