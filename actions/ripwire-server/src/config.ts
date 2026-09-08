import { resolve } from "node:path";

import { parseListenAddress, type ParsedListenAddress } from "./readiness.js";

export const DEFAULT_VERSION = "0.4.0";
export const DEFAULT_LISTEN = "127.0.0.1:7998";
export const DEFAULT_TOP_K = 200;
export const DEFAULT_STABLE_ORDER = true;
export const DEFAULT_REDACT = true;
export const DEFAULT_ALLOW_REMOTE_EDITS = false;
export const DEFAULT_STARTUP_TIMEOUT_SECONDS = 30;

export interface RipwireInputValues {
  readonly workingDirectory: string;
  readonly version?: string;
  readonly listen?: string;
  readonly topK?: string;
  readonly stableOrder?: string;
  readonly redact?: string;
  readonly mcpToken?: string;
  readonly allowRemoteEdits?: string;
  readonly startupTimeoutSeconds?: string;
}

export interface RipwireConfig {
  readonly workingDirectory: string;
  readonly version: string;
  readonly listen: string;
  readonly mcpUrl: string;
  readonly topK: number;
  readonly stableOrder: boolean;
  readonly redact: boolean;
  readonly mcpToken?: string;
  readonly allowRemoteEdits: boolean;
  readonly startupTimeoutSeconds: number;
}

function requiredString(value: string | undefined, name: string): string {
  const result = value?.trim();
  if (!result) throw new Error(`${name} is required`);
  return result;
}

export function normalizeVersion(value: string): string {
  const version = requiredString(value, "version").replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(
      "version must be a released semantic version in the form X.Y.Z",
    );
  }
  return version;
}

function parseInteger(
  value: string | undefined,
  name: string,
  minimum: number,
): number {
  const text = requiredString(value, name);
  if (!/^\d+$/.test(text)) {
    throw new Error(`${name} must be an integer`);
  }
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return number;
}

function parseBoolean(
  value: string | undefined,
  name: string,
  defaultValue: boolean,
): boolean {
  const text = value === undefined || value.trim() === "" ? undefined : value;
  if (text === undefined) return defaultValue;
  if (!/^(?:true|false)$/i.test(text.trim())) {
    throw new Error(`${name} must be true or false`);
  }
  return text.trim().toLowerCase() === "true";
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1";
}

export function parseRipwireInputs(input: RipwireInputValues): RipwireConfig {
  const workingDirectory = resolve(
    requiredString(input.workingDirectory, "working-directory"),
  );
  const version = normalizeVersion(input.version ?? DEFAULT_VERSION);
  const parsedListen: ParsedListenAddress = parseListenAddress(
    input.listen ?? DEFAULT_LISTEN,
  );
  const topK = parseInteger(input.topK ?? String(DEFAULT_TOP_K), "top-k", 0);
  const stableOrder = parseBoolean(
    input.stableOrder,
    "stable-order",
    DEFAULT_STABLE_ORDER,
  );
  const redact = parseBoolean(input.redact, "redact", DEFAULT_REDACT);
  const allowRemoteEdits = parseBoolean(
    input.allowRemoteEdits,
    "allow-remote-edits",
    DEFAULT_ALLOW_REMOTE_EDITS,
  );
  const startupTimeoutSeconds = parseInteger(
    input.startupTimeoutSeconds ?? String(DEFAULT_STARTUP_TIMEOUT_SECONDS),
    "startup-timeout-seconds",
    1,
  );
  const mcpToken = input.mcpToken?.trim() || undefined;

  if (!isLoopbackHost(parsedListen.host) && !mcpToken) {
    throw new Error("mcp-token is required for a non-loopback listen address");
  }
  if (allowRemoteEdits && !mcpToken) {
    throw new Error("mcp-token is required when allow-remote-edits is true");
  }

  return {
    workingDirectory,
    version,
    listen: parsedListen.listen,
    mcpUrl: parsedListen.mcpUrl,
    topK,
    stableOrder,
    redact,
    ...(mcpToken === undefined ? {} : { mcpToken }),
    allowRemoteEdits,
    startupTimeoutSeconds,
  };
}
