import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const sourceRoots = ["apps", "libs"].map((directory) =>
  resolve(repositoryRoot, directory),
);
const ignoredDirectories = new Set([
  ".git",
  ".pnpm-store",
  "dist",
  "node_modules",
  "out-tsc",
]);
const testFilePattern = /\.(?:spec|test)\.(?:ts|tsx)$/;
const implementationPattern = /\.(?:ts|tsx)$/;
const scopePattern = /@test-scope\s+([^\s*]+)/g;

function filesUnder(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(path));
    else if (testFilePattern.test(entry.name)) files.push(path);
  }
  return files;
}

function defaultImplementation(testFile) {
  const stem = testFile.replace(/\.(?:spec|test)\.(?:ts|tsx)$/, "");
  for (const extension of [".ts", ".tsx"]) {
    const candidate = `${stem}${extension}`;
    try {
      if (statSync(candidate).isFile()) return [candidate];
    } catch {
      // Try the next supported extension.
    }
  }
  return [];
}

function explicitImplementations(testFile, contents) {
  return [...contents.matchAll(scopePattern)].map((match) =>
    resolve(dirname(testFile), match[1].replace(/^['"]|['"]$/g, "")),
  );
}

const tests = sourceRoots.flatMap(filesUnder).sort();
const errors = [];
const mappings = [];

for (const testFile of tests) {
  const contents = readFileSync(testFile, "utf8");
  const targets = explicitImplementations(testFile, contents);
  const resolvedTargets = targets.length > 0 ? targets : defaultImplementation(testFile);

  if (resolvedTargets.length === 0) {
    errors.push(
      `${relative(repositoryRoot, testFile)}: no implementation target; add @test-scope ./path/to/implementation.ts`,
    );
    continue;
  }

  for (const target of resolvedTargets) {
    const relativeTarget = relative(repositoryRoot, target);
    if (!implementationPattern.test(target) || testFilePattern.test(target)) {
      errors.push(
        `${relative(repositoryRoot, testFile)}: invalid implementation target ${relativeTarget}`,
      );
      continue;
    }
    try {
      if (!statSync(target).isFile()) throw new Error();
    } catch {
      errors.push(
        `${relative(repositoryRoot, testFile)}: missing implementation target ${relativeTarget}`,
      );
      continue;
    }
    mappings.push(`${relative(repositoryRoot, testFile)} -> ${relativeTarget}`);
  }
}

if (errors.length > 0) {
  console.error("Test-to-implementation mapping failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Test-to-implementation mapping passed (${mappings.length} mappings).`);
}
