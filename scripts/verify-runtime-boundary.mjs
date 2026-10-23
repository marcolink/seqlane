import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  readdirSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import { expectedReleases } from "./verify-release-packages.mjs";

const retiredName = String.fromCodePoint(109, 97, 115, 116, 114, 97);
const families = ["actions", "apps", "libs", "workflows"];
const packageSchema = z.looseObject({ name: z.string().min(1) });
const dependencySchema = z.lazy(() =>
  z.looseObject({
    version: z.string(),
    path: z.string(),
    dependencies: z.record(z.string(), dependencySchema).optional(),
    optionalDependencies: z.record(z.string(), dependencySchema).optional(),
  }),
);
const productionSchema = z.array(
  z.looseObject({
    name: z.string(),
    path: z.string(),
    dependencies: z.record(z.string(), dependencySchema).optional(),
    optionalDependencies: z.record(z.string(), dependencySchema).optional(),
  }),
);

function capture(command, args, root) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 128 * 1024 * 1024,
  });
}

function check(label, contents = "") {
  if (
    label.toLowerCase().includes(retiredName) ||
    contents.toString().toLowerCase().includes(retiredName)
  )
    throw new Error(`Retired runtime evidence: ${label}`);
}

export function auditSource(root) {
  const paths = capture(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    root,
  ).split("\0");
  let files = 0;
  for (const path of paths) {
    if (!path) continue;
    const absolute = join(root, path);
    const info = lstatSync(absolute, { throwIfNoEntry: false });
    if (info === undefined) continue;
    const contents = info.isSymbolicLink()
      ? readlinkSync(absolute)
      : readFileSync(absolute);
    check(path, contents);
    files++;
  }
  return files;
}

function packages(root) {
  return families.flatMap((family) =>
    readdirSync(join(root, family), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(family, entry.name))
      .filter((path) => existsSync(join(root, path, "package.json"))),
  );
}

function scanDirectory(root, path) {
  let files = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const absolute = join(path, entry.name);
    check(relative(root, absolute));
    if (entry.isSymbolicLink())
      throw new Error(`Unexpected distribution symlink: ${absolute}`);
    if (entry.isDirectory()) files += scanDirectory(root, absolute);
    else {
      check(relative(root, absolute), readFileSync(absolute));
      files++;
    }
  }
  return files;
}

export function auditArchive(root, archive) {
  check(relative(root, archive));
  const entries = capture("tar", ["-tzf", archive], root);
  check(relative(root, archive), entries);
  check(
    relative(root, archive),
    gunzipSync(readFileSync(archive), { maxOutputLength: 128 * 1024 * 1024 }),
  );
}

function requireActionAssets(root, path, output) {
  if (!path.startsWith("actions/")) return;
  for (const name of ["main", "post", "process-anchor"]) {
    if (name !== "main" && !existsSync(join(root, path, "src", `${name}.ts`)))
      continue;
    if (!existsSync(join(output, `${name}.js`)))
      throw new Error(`Missing Action asset: ${path}/${name}.js`);
  }
}

function auditPackageOutputs(root, complete) {
  let files = 0;
  for (const path of packages(root)) {
    const output = join(
      root,
      path,
      path === "apps/docs" ? ".vitepress/dist" : "dist",
    );
    if (!existsSync(output)) {
      if (complete) throw new Error(`Missing built distribution: ${path}`);
      continue;
    }
    const count = scanDirectory(root, output);
    if (complete && count === 0)
      throw new Error(`Empty built distribution: ${path}`);
    files += count;
    if (complete) requireActionAssets(root, path, output);
  }
  return files;
}

function auditReleaseArchives(root, complete) {
  let archives = 0;
  for (const directory of [
    ".nx/package-smoke",
    ".nx/release-validation",
    ".nx/release-packages",
  ]) {
    const absolute = join(root, directory);
    if (!existsSync(absolute)) continue;
    for (const name of readdirSync(absolute).filter((name) =>
      name.endsWith(".tgz"),
    )) {
      auditArchive(root, join(absolute, name));
      archives++;
    }
  }
  if (complete)
    for (const project of expectedReleases.keys()) {
      if (!existsSync(join(root, ".nx/package-smoke", `${project}.tgz`)))
        throw new Error(`Missing production archive: ${project}`);
    }
  return archives;
}

export function auditGenerated(root, complete = false) {
  return {
    files: auditPackageOutputs(root, complete),
    archives: auditReleaseArchives(root, complete),
  };
}

export function auditProduction(root) {
  const raw = capture(
    "pnpm",
    ["list", "-r", "--prod", "--depth", "Infinity", "--json"],
    root,
  );
  check("production dependency closure", raw);
  const graph = productionSchema.parse(JSON.parse(raw));
  const expected = new Set(
    ["", ...packages(root)].map(
      (path) =>
        packageSchema.parse(
          JSON.parse(readFileSync(join(root, path, "package.json"), "utf8")),
        ).name,
    ),
  );
  if (
    expected.size !== 24 ||
    graph.length !== expected.size ||
    new Set(graph.map((entry) => entry.name)).size !== expected.size ||
    graph.some((entry) => !expected.has(entry.name))
  )
    throw new Error(
      "Production dependency graph does not cover every workspace package",
    );
  const dependencies = new Set();
  function visit(entry) {
    for (const children of [entry.dependencies, entry.optionalDependencies])
      for (const child of Object.values(children ?? {})) {
        dependencies.add(child.path);
        visit(child);
      }
  }
  graph.forEach(visit);
  return {
    workspacePackages: expected.size - 1,
    productionDependencies: dependencies.size,
  };
}

export function main(args = process.argv.slice(2)) {
  if (
    args.length > 1 ||
    args.some((arg) => !["--source", "--distributions"].includes(arg))
  )
    throw new Error(
      "Usage: verify-runtime-boundary.mjs [--source|--distributions]",
    );
  const root = resolve(import.meta.dirname, "..");
  const sourceFiles = auditSource(root);
  const production = auditProduction(root);
  const generated = args.includes("--source")
    ? { files: 0, archives: 0 }
    : auditGenerated(root, args.includes("--distributions"));
  console.log(
    JSON.stringify({
      sourceFiles,
      ...production,
      generatedFiles: generated.files,
      archives: generated.archives,
      retiredEvidence: 0,
    }),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main();
