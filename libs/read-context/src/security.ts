import { basename, relative, resolve, sep } from "node:path";

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
