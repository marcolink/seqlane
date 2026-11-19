import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  expectedReleases,
  validateArchiveEntries,
  validatePackedManifest,
} from "./verify-release-packages.mjs";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, ".nx/package-smoke");
const consumer = mkdtempSync(join(tmpdir(), "seqlane-installed-"));
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith("SEQLANE_") && key !== "NODE_OPTIONS",
  ),
);

function capture(command, args, cwd = root) {
  return execFileSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

// This consumes development tarballs too. The publishing verifier separately
// rejects 0.0.0 and enforces release metadata before any registry write.
try {
  mkdirSync(output, { recursive: true });
  const dependencies = {};
  for (const [project, name] of expectedReleases) {
    const configuration = JSON.parse(
      capture("pnpm", ["exec", "nx", "show", "project", project, "--json"]),
    );
    const source = JSON.parse(
      readFileSync(resolve(root, configuration.root, "package.json"), "utf8"),
    );
    const archive = join(output, `${project}.tgz`);
    capture("pnpm", [
      "--dir",
      configuration.root,
      "pack",
      "--json",
      "--out",
      archive,
    ]);
    validateArchiveEntries(name, capture("tar", ["-tzf", archive]).split("\n"));
    validatePackedManifest(
      name,
      source.version,
      JSON.parse(capture("tar", ["-xOf", archive, "package/package.json"])),
    );
    dependencies[name] = `file:${archive}`;
  }
  const rootManifest = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  );
  dependencies.zod = rootManifest.devDependencies.zod;
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({
      name: "seqlane-installed-smoke",
      private: true,
      type: "module",
      dependencies,
      pnpm: {
        overrides: Object.fromEntries(
          Object.entries(dependencies).filter(([name]) => name !== "zod"),
        ),
      },
    }),
  );
  writeFileSync(
    join(consumer, ".npmrc"),
    "auto-install-peers=false\nstrict-peer-dependencies=false\n",
  );
  capture(
    "pnpm",
    ["install", "--ignore-scripts", "--store-dir", join(root, ".pnpm-store")],
    consumer,
  );
  writeFileSync(
    join(consumer, "workflow.mjs"),
    `
import { createFlow, defineTask } from "@seqlane/core";
import { z } from "zod";
const schema = z.strictObject({ value: z.boolean() });
const task = defineTask({ id: "installed-echo", input: schema, output: schema,
  execute: async ({ input }) => input });
export default createFlow({ id: "installed-smoke", input: schema, output: schema })
  .task("echo", task, ({ input }) => input)
  .output(({ tasks }) => tasks.echo.output).define();
`,
  );
  writeFileSync(
    join(consumer, "consumer.ts"),
    `
import { buildWorkflow, createFlow, defineTask } from "@seqlane/core";
import { startWorkflowRun } from "@seqlane/runtime";
import { z } from "zod";
const schema = z.strictObject({ value: z.boolean() });
const task = defineTask({ id: "typed-installed-echo", input: schema, output: schema,
  execute: async ({ input }) => input });
const workflow = createFlow({ id: "typed-installed-smoke", input: schema, output: schema })
  .task("echo", task, ({ input }) => input)
  .output(({ tasks }) => tasks.echo.output).define();
startWorkflowRun({ workflow: buildWorkflow(workflow), input: { value: false },
  events: { emit: () => undefined } });
`,
  );
  capture(
    process.execPath,
    [
      join(root, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--module",
      "NodeNext",
      "--target",
      "ES2023",
      "consumer.ts",
    ],
    consumer,
  );
  writeFileSync(
    join(consumer, "smoke.mjs"),
    `
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
const names = ${JSON.stringify([...expectedReleases.values()])};
const root = process.cwd();
for (const name of names) {
  const entry = realpathSync(fileURLToPath(import.meta.resolve(name)));
  const path = relative(root, entry);
  assert(!path.startsWith("..") && !isAbsolute(path), name + " escaped installed consumer");
  await import(name);
  const packageRoot = resolve(dirname(entry), "..");
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
  for (const conditions of Object.values(manifest.exports)) {
    for (const target of typeof conditions === "string" ? [conditions] : Object.values(conditions)) {
      assert(existsSync(resolve(packageRoot, target)), name + " missing export " + target);
    }
  }
}
const { default: workflow } = await import("./workflow.mjs");
const { buildWorkflow } = await import("@seqlane/core");
const { startWorkflowRun } = await import("@seqlane/runtime");
const events = [];
const handle = startWorkflowRun({ workflow: buildWorkflow(workflow), input: { value: false },
  events: { emit: (event) => events.push(event) } });
assert.deepEqual(await handle.outcome, { status: "succeeded", result: { value: false } });
assert.equal(events[0].type, "run.started");
assert.equal(events.at(-1).type, "run.succeeded");
const cli = resolve(dirname(fileURLToPath(import.meta.resolve("seqlane"))), "../bin/run.js");
const run = (...args) => execFileSync(process.execPath, [cli, ...args], {
  encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
assert.match(run("--help"), /run/);
const plan = JSON.parse(run("unstable_plan", "./workflow.mjs", "--output", "json"));
assert.equal(plan.workflow.exportName, "default");
const result = JSON.parse(run("run", "./workflow.mjs", "--input", '{"value":false}', "--json"));
assert.equal(result.status, "succeeded");
assert.deepEqual(result.output, { value: false });
assert(!existsSync(".seqlane"), "standalone execution created operational storage");
console.log(JSON.stringify({ installedPackages: names.length, cli: true, plan: true,
  direct: true, falseyOutput: result.output, canonicalEvents: events.length }));
`,
  );
  const result = capture(process.execPath, ["smoke.mjs"], consumer);
  assert(result.includes('"installedPackages":8'));
  console.log(result);
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
