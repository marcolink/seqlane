import { posix, win32 } from "node:path";

/** Checks executable paths using the path rules of the runtime platform. */
export function isAbsoluteCodexExecutablePath(
  value: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return (platform === "win32" ? win32 : posix).isAbsolute(value);
}
