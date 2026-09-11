import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const ripwireWorkflowPaths = new Set([".github/workflows/ci.yml"]);

function normalizePath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isDocumentationPath(path) {
  return (
    path.startsWith("docs/") ||
    path.startsWith(".changeset/") ||
    path === "README.md" ||
    path === "LICENSE" ||
    path.endsWith(".md") ||
    path.endsWith(".mdx")
  );
}

function isRipwirePath(path) {
  return (
    path.startsWith("actions/ripwire-server/") ||
    path.startsWith("libs/action-service-lifecycle/")
  );
}

export function classifyPaths(inputPaths) {
  const paths = Array.isArray(inputPaths)
    ? inputPaths.filter((path) => typeof path === "string" && path.length > 0)
    : [];

  if (paths.length === 0) {
    return { ripwire_relevant: "true" };
  }

  let ripwireRelevant = false;
  let unknown = false;

  for (const rawPath of paths) {
    const path = normalizePath(rawPath);
    if (isDocumentationPath(path)) continue;

    if (path.startsWith("apps/")) continue;

    if (path.startsWith("actions/")) {
      ripwireRelevant ||= isRipwirePath(path);
      continue;
    }

    if (path.startsWith("libs/")) {
      ripwireRelevant ||= isRipwirePath(path);
      continue;
    }

    if (path.startsWith(".github/workflows/")) {
      ripwireRelevant ||= ripwireWorkflowPaths.has(path);
      continue;
    }

    unknown = true;
  }

  if (unknown) {
    return { ripwire_relevant: "true" };
  }

  return { ripwire_relevant: String(ripwireRelevant) };
}

function argumentValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function changedPaths(base, head) {
  const shaPattern = /^[0-9a-f]{40}$/i;
  if (!shaPattern.test(base ?? "") || !shaPattern.test(head ?? "")) return null;

  const result = spawnSync(
    "git",
    ["diff", "--no-renames", "--name-only", "-z", `${base}..${head}`],
    { encoding: "utf8" },
  );
  if (result.error || result.status !== 0) return null;

  return result.stdout.split("\0").filter(Boolean);
}

export function main(args = process.argv.slice(2)) {
  const classification = classifyPaths(
    changedPaths(argumentValue(args, "--base"), argumentValue(args, "--head")),
  );
  for (const [name, value] of Object.entries(classification)) {
    console.log(`${name}=${value}`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
