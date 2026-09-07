import { createReadStream } from "node:fs";
import { chmod, lstat, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function findExecutables(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const matches: string[] = [];
  for (const entry of entries) {
    const entryPath = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `OpenCode archive contains an unsafe symbolic link: ${entry.name}`,
      );
    }
    if (entry.isDirectory()) {
      matches.push(...(await findExecutables(entryPath)));
      continue;
    }
    if (entry.isFile()) {
      const fileStat = await lstat(entryPath);
      if (basename(entryPath) === "opencode") {
        matches.push(resolve(entryPath));
      } else if ((fileStat.mode & 0o111) !== 0) {
        throw new Error(
          `OpenCode archive contains an unexpected executable: ${entry.name}`,
        );
      }
    }
  }
  return matches;
}

export async function locateExecutable(root: string): Promise<string> {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("OpenCode extraction directory is not a safe directory.");
  }
  const matches = await findExecutables(root);
  if (matches.length !== 1) {
    throw new Error(
      `OpenCode archive must contain exactly one opencode executable; found ${matches.length}.`,
    );
  }
  const [executable] = matches;
  if (executable === undefined) {
    throw new Error("OpenCode executable was not found.");
  }
  await chmod(executable, 0o755);
  return executable;
}
