import { open } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { MAX_LOCKFILE_INPUT_FILE_BYTES } from "./contracts.js";
import { ActionResolutionError } from "./errors.js";

const packageManifestSchema = z.record(z.string(), z.unknown());
const lockfileDependencyFields = new Set([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "overrides",
  "packageExtensions",
  "patchedDependencies",
]);
const unsafeLockfileSpecPattern =
  /(?:https?:\/\/|ssh:\/\/|git(?:\+[^:]+)?:|github:|gitlab:|bitbucket:|file:|link:|portal:|patch:|^\/\/)/i;

function lockfileInputError(
  message: string,
  cause?: unknown,
): ActionResolutionError {
  return new ActionResolutionError(
    "lockfile",
    "LOCKFILE_REGENERATION_FAILED",
    message,
    cause,
  );
}

function validateLockfileDependencySpec(value: string, path: string): void {
  const spec = value.trim();
  if (
    spec.length === 0 ||
    unsafeLockfileSpecPattern.test(spec) ||
    (!spec.startsWith("workspace:") &&
      !spec.startsWith("catalog:") &&
      !spec.startsWith("npm:") &&
      (spec.includes("/") || spec.includes(":")))
  ) {
    throw lockfileInputError(
      `The lockfile input contains an unsupported dependency source in ${path}.`,
    );
  }
  if (spec.startsWith("npm:")) {
    const alias = spec.slice("npm:".length);
    const versionSeparator = alias.lastIndexOf("@");
    const packageName = alias.slice(0, versionSeparator);
    const version = alias.slice(versionSeparator + 1);
    if (
      versionSeparator <= 0 ||
      !/^(?:@[^/\s]+\/)?[^@/\s]+$/.test(packageName) ||
      version.length === 0 ||
      version.includes("/") ||
      version.includes(":")
    ) {
      throw lockfileInputError(
        `The lockfile input contains an unsupported npm alias in ${path}.`,
      );
    }
  }
}

function validateLockfileDependencyValues(value: unknown, path: string): void {
  if (typeof value === "string") {
    validateLockfileDependencySpec(value, path);
    return;
  }
  const parsed = z.record(z.string(), z.unknown()).safeParse(value);
  if (!parsed.success) {
    throw lockfileInputError(
      `The lockfile input dependency map is malformed in ${path}.`,
      parsed.error,
    );
  }
  for (const [name, dependency] of Object.entries(parsed.data)) {
    validateLockfileDependencyValues(dependency, `${path}.${name}`);
  }
}

async function readLockfileInput(path: string): Promise<string> {
  const file = await open(path, "r");
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (totalBytes <= MAX_LOCKFILE_INPUT_FILE_BYTES) {
      const chunk = Buffer.alloc(
        Math.min(64 * 1024, MAX_LOCKFILE_INPUT_FILE_BYTES + 1 - totalBytes),
      );
      const { bytesRead } = await file.read(chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > MAX_LOCKFILE_INPUT_FILE_BYTES) {
        throw lockfileInputError(
          "The lockfile input exceeds the per-file size limit.",
        );
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
  } finally {
    await file.close();
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

export async function validateLockfileInput(
  sourceRoot: string,
  path: string,
): Promise<void> {
  const contents = await readLockfileInput(join(sourceRoot, path));
  if (path === "pnpm-workspace.yaml") {
    if (
      unsafeLockfileSpecPattern.test(contents) ||
      /^\s*(?:registry|registries|npmrc)\s*:/im.test(contents)
    ) {
      throw lockfileInputError(
        "The lockfile workspace configuration contains an unsupported registry or dependency source.",
      );
    }
    return;
  }
  if (!path.endsWith("package.json")) return;
  let document: unknown;
  try {
    document = JSON.parse(contents);
  } catch (error: unknown) {
    throw lockfileInputError(
      `The lockfile input manifest is not valid JSON: ${path}.`,
      error,
    );
  }
  const manifest = packageManifestSchema.safeParse(document);
  if (!manifest.success) {
    throw lockfileInputError(
      `The lockfile input manifest is malformed: ${path}.`,
      manifest.error,
    );
  }
  for (const [name, value] of Object.entries(manifest.data)) {
    if (lockfileDependencyFields.has(name)) {
      validateLockfileDependencyValues(value, `${path}.${name}`);
    }
  }
  const pnpm = z.record(z.string(), z.unknown()).safeParse(manifest.data.pnpm);
  if (pnpm.success) {
    for (const [name, value] of Object.entries(pnpm.data)) {
      if (lockfileDependencyFields.has(name)) {
        validateLockfileDependencyValues(value, `${path}.pnpm.${name}`);
      }
    }
  }
}
