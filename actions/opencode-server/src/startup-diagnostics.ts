import { open } from "node:fs/promises";

const MAX_LOG_BYTES = 16 * 1024;

export async function readStartupDiagnostics(
  logPath: string,
  secrets: readonly string[],
): Promise<string> {
  try {
    const file = await open(logPath, "r");
    try {
      const { size } = await file.stat();
      const position = Math.max(0, size - MAX_LOG_BYTES);
      const buffer = Buffer.alloc(Math.min(size, MAX_LOG_BYTES));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      let text = buffer.subarray(0, bytesRead).toString("utf8");
      if (position > 0) {
        const newline = text.indexOf("\n");
        text = newline < 0 ? "" : text.slice(newline + 1);
      }
      for (const secret of secrets
        .filter(Boolean)
        .sort((a, b) => b.length - a.length))
        text = text.split(secret).join("[REDACTED]");
      return text.trim() || "OpenCode produced no startup log.";
    } finally {
      await file.close();
    }
  } catch {
    return "OpenCode startup log is unavailable.";
  }
}
