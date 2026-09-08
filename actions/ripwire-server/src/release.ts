import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { gunzipSync } from "node:zlib";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { promisify } from "node:util";
import { buildRipwireEnvironment } from "./commands.js";

export interface VersionCommandOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeout: number;
  readonly maxBuffer: number;
}

export type VersionCommandRunner = (
  binaryPath: string,
  args: string[],
  options: VersionCommandOptions,
) => Promise<{ readonly stdout: string }>;

// Narrow the promisified Node overload to the options used by version checks.
const execFileAsync = promisify(execFile) as VersionCommandRunner;

export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const MAX_CHECKSUM_BYTES = 4 * 1024;
export const MAX_UNPACKED_ARCHIVE_BYTES = 256 * 1024 * 1024;
export const DOWNLOAD_TIMEOUT_MILLISECONDS = 60_000;

/** Repository-owned digests for the supported Ripwire release assets. */
export const TRUSTED_RELEASE_DIGESTS = {
  "0.4.0": {
    linux: {
      x64: "fd0bd0fa849c0e08db59a6a7e5c2d3e9bc062d3089b54196daf9332cd21bbfc8",
      arm64: "9b82e4d13928974349730b9e713ff71118f5a65967753b03a3ce0b5e352be9c1",
    },
    macos: {
      x64: "34c0b99dcdc3c592d2bc41bb3a34f95338cba5e4fa4fbd0b9579ae0b80bd47e8",
      arm64: "ee8392f4e48be2076f18558ebae08c51dd90d616988a396e14fcdbc192f7a53d",
    },
  },
} as const;

export interface ReleaseTarget {
  readonly version: string;
  readonly platform: "linux" | "macos";
  readonly architecture: "x64" | "arm64";
  readonly archiveName: string;
  readonly checksumName: string;
  readonly archiveUrl: string;
  readonly checksumUrl: string;
  readonly rootDirectory: string;
  readonly trustedSha256: string;
}

export interface InstalledRipwire {
  readonly version: string;
  readonly binaryPath: string;
  readonly binaryDirectory: string;
}

export interface DownloadOptions {
  readonly maxBytes: number;
  readonly timeoutMilliseconds?: number;
  readonly fetchImpl?: typeof fetch;
}

export function trustedReleaseDigest(
  version: string,
  platform: "linux" | "macos",
  architecture: "x64" | "arm64",
): string {
  if (version !== "0.4.0") {
    throw new Error(
      `Ripwire release version ${version} is not in the repository trust table`,
    );
  }
  return TRUSTED_RELEASE_DIGESTS[version][platform][architecture];
}

export function releaseTarget(
  version: string,
  platform: NodeJS.Platform = process.platform,
  architecture: NodeJS.Architecture = process.arch,
): ReleaseTarget {
  const normalizedVersion = version.replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(normalizedVersion)) {
    throw new Error("Cannot build a release target for an invalid version");
  }
  const targetPlatform =
    platform === "linux"
      ? "linux"
      : platform === "darwin"
        ? "macos"
        : undefined;
  if (!targetPlatform) {
    throw new Error(`Ripwire does not publish a binary for ${platform}`);
  }
  const targetArchitecture =
    architecture === "x64" || architecture === "arm64"
      ? architecture
      : undefined;
  if (!targetArchitecture) {
    throw new Error(`Ripwire does not publish a binary for ${architecture}`);
  }
  const trustedSha256 = trustedReleaseDigest(
    normalizedVersion,
    targetPlatform,
    targetArchitecture,
  );
  const stem = `ripwire-${normalizedVersion}-${targetPlatform}-${targetArchitecture}`;
  return {
    version: normalizedVersion,
    platform: targetPlatform,
    architecture: targetArchitecture,
    archiveName: `${stem}.tar.gz`,
    checksumName: `${stem}.tar.gz.sha256`,
    archiveUrl: `https://github.com/redhat-et/ripwire/releases/download/v${normalizedVersion}/${stem}.tar.gz`,
    checksumUrl: `https://github.com/redhat-et/ripwire/releases/download/v${normalizedVersion}/${stem}.tar.gz.sha256`,
    rootDirectory: `${stem}/`,
    trustedSha256,
  };
}

async function readResponseBytes(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredSize = Number(contentLength);
    if (
      !Number.isSafeInteger(declaredSize) ||
      declaredSize < 0 ||
      declaredSize > maxBytes
    ) {
      throw new Error(
        `Release download exceeds its ${maxBytes}-byte size limit`,
      );
    }
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new Error(
        `Release download exceeds its ${maxBytes}-byte size limit`,
      );
    }
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        throw new Error(
          `Release download exceeds its ${maxBytes}-byte size limit`,
        );
      }
      chunks.push(next.value);
    }
  } finally {
    await Promise.resolve(reader.cancel()).catch(() => undefined);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function downloadBytes(
  url: string,
  options: DownloadOptions,
): Promise<Uint8Array> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMilliseconds =
    options.timeoutMilliseconds ?? DOWNLOAD_TIMEOUT_MILLISECONDS;
  const response = await fetchImpl(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMilliseconds),
  });
  try {
    if (!response.ok)
      throw new Error(`Release download failed with HTTP ${response.status}`);
    return await readResponseBytes(response, options.maxBytes);
  } finally {
    await Promise.resolve(response.body?.cancel()).catch(() => undefined);
  }
}

function parseChecksum(contents: string, archiveName: string): string {
  const fields = contents.trim().split(/\s+/);
  const digest = fields[0]?.toLowerCase();
  const filename = fields[1]?.replace(/^\*/, "");
  if (!digest || !/^[a-f0-9]{64}$/.test(digest) || filename !== archiveName) {
    throw new Error("Release checksum file has an invalid format");
  }
  return digest;
}

export function verifySha256(
  archive: Uint8Array,
  checksumFile: Uint8Array,
  archiveName: string,
): void {
  const expected = parseChecksum(
    new TextDecoder().decode(checksumFile),
    archiveName,
  );
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== expected)
    throw new Error("Ripwire release checksum verification failed");
}

export function verifyTrustedSha256(
  archive: Uint8Array,
  expected: string,
): void {
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== expected) {
    throw new Error(
      "Ripwire release does not match the repository trust digest",
    );
  }
}

function tarText(buffer: Uint8Array, start: number, length: number): string {
  const bytes = buffer.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end));
}

function tarNumber(buffer: Uint8Array, start: number, length: number): number {
  const text = tarText(buffer, start, length).trim().replace(/\0/g, "");
  if (!text) return 0;
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("Ripwire archive contains an invalid tar size");
  return value;
}

interface TarEntry {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  readonly dataOffset: number;
}

function listTarEntries(unpacked: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let sawEnd = false;
  for (let offset = 0; offset + 512 <= unpacked.length;) {
    const header = unpacked.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      sawEnd = true;
      break;
    }
    const name = tarText(unpacked, offset, 100);
    const prefix = tarText(unpacked, offset + 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const type = String.fromCharCode(unpacked[offset + 156] ?? 0) || "0";
    const size = tarNumber(unpacked, offset + 124, 12);
    const dataOffset = offset + 512;
    const end = dataOffset + size;
    if (!name || end > unpacked.length)
      throw new Error("Ripwire archive contains a truncated tar entry");
    entries.push({
      name: fullName,
      type: type === "\0" ? "0" : type,
      size,
      dataOffset,
    });
    offset = dataOffset + Math.ceil(size / 512) * 512;
  }
  if (entries.length === 0 || !sawEnd)
    throw new Error("Ripwire archive is empty or has no tar end marker");
  return entries;
}

export function extractBinary(
  archive: Uint8Array,
  target: ReleaseTarget,
  binaryPath: string,
): void {
  if (archive.byteLength > MAX_ARCHIVE_BYTES)
    throw new Error("Ripwire archive exceeds its size limit");
  let unpacked: Uint8Array;
  try {
    unpacked = gunzipSync(archive, {
      maxOutputLength: MAX_UNPACKED_ARCHIVE_BYTES,
    });
  } catch (error) {
    throw new Error("Ripwire release is not a valid gzip archive", {
      cause: error,
    });
  }
  const entries = listTarEntries(unpacked);
  const root = target.rootDirectory;
  let foundRoot = false;
  let binary: TarEntry | undefined;
  for (const entry of entries) {
    const rootEntry = entry.name === root.slice(0, -1) || entry.name === root;
    if (
      (!rootEntry && !entry.name.startsWith(root)) ||
      entry.name.includes("\\") ||
      entry.name.includes("\0")
    ) {
      throw new Error("Ripwire archive contains an invalid path");
    }
    if (rootEntry) {
      if (entry.type !== "5")
        throw new Error("Ripwire archive root is not a directory");
      foundRoot = true;
      continue;
    }
    const relative = entry.name.slice(root.length);
    if (
      !relative ||
      relative === "." ||
      relative.startsWith("/") ||
      relative.split("/").includes("..")
    ) {
      throw new Error("Ripwire archive contains an invalid path");
    }
    if (entry.type !== "0" && entry.type !== "5") {
      throw new Error(
        "Ripwire archive contains a symlink or unsupported tar member",
      );
    }
    if (relative === "ripwire") {
      if (entry.type !== "0" || entry.size === 0 || binary) {
        throw new Error("Ripwire archive has an invalid binary member");
      }
      binary = entry;
    }
  }
  if (!foundRoot || !binary) {
    throw new Error(
      `Ripwire archive does not contain the expected ${root} directory and binary`,
    );
  }
  const bytes = unpacked.subarray(
    binary.dataOffset,
    binary.dataOffset + binary.size,
  );
  return void writeBinary(binaryPath, bytes);
}

function writeBinary(path: string, bytes: Uint8Array): void {
  writeFileSync(path, bytes, { flag: "wx", mode: 0o755 });
}

export interface InstallOptions {
  readonly version: string;
  readonly runnerTemp: string;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: NodeJS.Architecture;
  readonly fetchImpl?: typeof fetch;
  readonly runVersion?: (binaryPath: string) => Promise<string>;
  readonly removePartialInstall?: (installDirectory: string) => Promise<void>;
}

export class RipwireInstallError extends Error {
  readonly installDirectory: string;
  readonly cleanupSucceeded = false;
  readonly cleanupError: unknown;

  constructor(cause: unknown, installDirectory: string, cleanupError: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "RipwireInstallError";
    this.installDirectory = installDirectory;
    this.cleanupError = cleanupError;
  }
}

export async function removeInstallDirectory(
  installDirectory: string,
  runnerTemp: string,
): Promise<void> {
  const root = resolve(runnerTemp);
  const target = resolve(installDirectory);
  const relativePath = relative(root, target);
  if (
    !relativePath ||
    relativePath.startsWith("..") ||
    isAbsolute(relativePath) ||
    !basename(target).startsWith("ripwire-")
  ) {
    throw new Error(
      "Refusing to remove an install directory outside RUNNER_TEMP",
    );
  }
  await rm(target, { recursive: true, force: true });
}

export async function verifyBinaryVersion(
  binaryPath: string,
  expectedVersion: string,
  execImpl: VersionCommandRunner = execFileAsync,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const { stdout } = await execImpl(binaryPath, ["--version"], {
    cwd: dirname(binaryPath),
    env: buildRipwireEnvironment(
      baseEnvironment,
      dirname(binaryPath),
      undefined,
    ),
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
  const match = stdout.trim().match(/\bripwire\s+v?(\d+\.\d+\.\d+)\b/i);
  if (!match || match[1] !== expectedVersion) {
    throw new Error(
      `Ripwire binary version mismatch; expected ${expectedVersion}`,
    );
  }
  return match[1];
}

export async function installRipwire(
  options: InstallOptions,
): Promise<InstalledRipwire> {
  const target = releaseTarget(
    options.version,
    options.platform,
    options.architecture,
  );
  const installDirectory = await mkdtemp(join(options.runnerTemp, "ripwire-"));
  try {
    const archivePath = join(installDirectory, target.archiveName);
    const checksumPath = join(installDirectory, target.checksumName);
    const [archive, checksum] = await Promise.all([
      downloadBytes(target.archiveUrl, {
        maxBytes: MAX_ARCHIVE_BYTES,
        fetchImpl: options.fetchImpl,
      }),
      downloadBytes(target.checksumUrl, {
        maxBytes: MAX_CHECKSUM_BYTES,
        fetchImpl: options.fetchImpl,
      }),
    ]);
    await writeFile(archivePath, archive, { mode: 0o600 });
    await writeFile(checksumPath, checksum, { mode: 0o600 });
    verifySha256(archive, checksum, target.archiveName);
    verifyTrustedSha256(archive, target.trustedSha256);
    const binaryPath = join(installDirectory, "ripwire");
    extractBinary(archive, target, binaryPath);
    await chmod(binaryPath, 0o755);
    const version = options.runVersion
      ? await options.runVersion(binaryPath)
      : await verifyBinaryVersion(binaryPath, target.version);
    if (version !== target.version) {
      throw new Error(
        `Ripwire binary version mismatch; expected ${target.version}`,
      );
    }
    await Promise.all([
      rm(archivePath, { force: true }),
      rm(checksumPath, { force: true }),
    ]);
    const details = await stat(binaryPath);
    if (!details.isFile())
      throw new Error("Installed Ripwire binary is not a regular file");
    return {
      version: target.version,
      binaryPath,
      binaryDirectory: installDirectory,
    };
  } catch (error) {
    try {
      await (
        options.removePartialInstall ??
        ((directory: string) => rm(directory, { recursive: true, force: true }))
      )(installDirectory);
    } catch (cleanupError) {
      throw new RipwireInstallError(error, installDirectory, cleanupError);
    }
    throw error;
  }
}

export function assetNameForPlatform(
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
): string {
  return releaseTarget("0.4.0", platform, architecture).archiveName;
}
