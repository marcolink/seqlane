import { readFile, writeFile } from "node:fs/promises";

for (const path of process.argv.slice(2)) {
  const contents = await readFile(path, "utf8");
  await writeFile(path, contents.replace(/[\t ]+$/gm, ""));
}
