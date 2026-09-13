import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";

const deniedDirectoryNames = new Set([
  ".git",
  ".nx",
  "__generated__",
  "build",
  "coverage",
  "dist",
  "generated",
  "node_modules",
  "out",
  "vendor",
]);

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

export function isPathWithinRoot(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && relativePath !== "..")
  );
}

function hasSafeRealPath(root: string, candidate: string): boolean {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  if (!isPathWithinRoot(rootPath, candidatePath)) return false;
  try {
    let current = rootPath;
    for (const segment of relative(rootPath, candidatePath)
      .split(sep)
      .filter(Boolean)) {
      current = join(current, segment);
      if (lstatSync(current).isSymbolicLink()) return false;
    }
    return isPathWithinRoot(
      realpathSync(rootPath),
      realpathSync(candidatePath),
    );
  } catch {
    return false;
  }
}

/** Resolves an existing path only when every repository component is real. */
export function resolveSafePath(
  root: string,
  candidate: string,
  kind: "file" | "directory" | "either" = "either",
): string | undefined {
  const absolute = resolve(root, candidate);
  if (!hasSafeRealPath(root, absolute)) return undefined;
  try {
    const stats = statSync(absolute);
    if (
      (kind === "file" && !stats.isFile()) ||
      (kind === "directory" && !stats.isDirectory())
    )
      return undefined;
    return absolute;
  } catch {
    return undefined;
  }
}

export function repositoryRelativePath(
  root: string,
  candidate: string,
): string {
  return toPosixPath(relative(resolve(root), resolve(candidate)));
}

export function deniedPathReason(repositoryPath: string): string | undefined {
  const normalized = toPosixPath(repositoryPath);
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => deniedDirectoryNames.has(segment))) {
    return "generated, vendor, or repository metadata path";
  }

  const name = basename(normalized);
  if (/^\.env(?:\.|$)/i.test(name)) return "environment file";
  if (/^(?:credentials?|secrets?)(?:\.|$)/i.test(name)) {
    return "credential or secret file";
  }
  if (/^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/i.test(name)) {
    return "private key file";
  }
  if (/(?:\.pem|\.key|\.p12|\.pfx|\.jks|\.keystore)$/i.test(name)) {
    return "private key or certificate file";
  }
  if (name === ".npmrc" || name === ".pypirc" || name === "config.json") {
    if (segments.includes(".docker") || name !== "config.json") {
      return "credential configuration file";
    }
  }
  if (
    normalized.endsWith("/.aws/credentials") ||
    normalized === ".aws/credentials"
  ) {
    return "cloud credential file";
  }
  if (/\.tfstate(?:\.|$)/i.test(name))
    return "state file may contain credentials";
  return undefined;
}

export function commandPathGlobs(): readonly string[] {
  return [
    "!**/.git/**",
    "!**/.nx/**",
    "!**/.env*",
    "!**/node_modules/**",
    "!**/vendor/**",
    "!**/dist/**",
    "!**/build/**",
    "!**/coverage/**",
    "!**/generated/**",
    "!**/__generated__/**",
    "!**/*.pem",
    "!**/*.key",
    "!**/*.p12",
    "!**/*.pfx",
  ];
}
