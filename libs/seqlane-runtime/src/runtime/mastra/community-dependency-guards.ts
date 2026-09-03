import { readFileSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const ignoredDirectories = new Set(["dist", "node_modules", "out-tsc"]);
const sourceExtensions = new Set([".cjs", ".js", ".mjs", ".ts", ".tsx"]);

export interface BoundaryViolation {
  readonly path: string;
  readonly line: number;
  readonly match: string;
}

function filesUnder(directory: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;

    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...filesUnder(path));
      continue;
    }

    if (entry.name === "package.json" || sourceExtensions.has(extname(path))) {
      files.push(path);
    }
  }

  return files.sort();
}

function violationsIn(
  paths: readonly string[],
  pattern: RegExp,
): BoundaryViolation[] {
  return paths.flatMap((path) => {
    const contents = readFileSync(path, "utf8");
    return [...contents.matchAll(pattern)].map((match) => ({
      path,
      line: contents.slice(0, match.index ?? 0).split("\n").length,
      match: match[0],
    }));
  });
}

function throwForViolations(
  description: string,
  violations: readonly BoundaryViolation[],
): void {
  if (violations.length === 0) return;

  const details = violations
    .map(({ path, line, match }) => `${path}:${line} (${match})`)
    .join(", ");
  throw new Error(`${description}: ${details}`);
}

export function publicPackageBoundaryFiles(repositoryRoot: string): string[] {
  return ["libs/seqlane-core", "libs/seqlane-events"].flatMap((directory) =>
    filesUnder(resolve(repositoryRoot, directory)),
  );
}

export function runtimeProductionSourceFiles(repositoryRoot: string): string[] {
  return filesUnder(resolve(repositoryRoot, "libs/seqlane-runtime/src")).filter(
    (path) => !path.endsWith(".spec.ts") && !path.endsWith(".test.ts"),
  );
}

export function assertNoMastraImports(paths: readonly string[]): void {
  throwForViolations(
    "Mastra import crossed the public package boundary",
    violationsIn(paths, /@mastra\//g),
  );
}

export function assertNoForbiddenEnterpriseImports(
  paths: readonly string[],
): void {
  throwForViolations(
    "Mastra Enterprise Edition import is forbidden",
    violationsIn(
      paths,
      /(?:from\s*|import\s*\(|require\s*\()\s*["'][^"']*\/ee(?:\/|["'])/g,
    ),
  );
}
