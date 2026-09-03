import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const defaultSdlcRoot = resolve(import.meta.dirname, "..", "docs", "sdlc");
const sections = [
  ["brd", "Business requirements"],
  ["prd", "Product requirements"],
  ["rfcs", "Requests for comments"],
  ["adrs", "Architecture decision records"],
  ["specs", "Technical specifications"],
  ["tasks", "Implementation tasks"],
];

function field(contents, name) {
  return contents.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1].trim();
}

export function parseOwners(contents) {
  const list = contents.match(
    /^owners:\s*\n((?:[ \t]+-[ \t]+.+(?:\n|$))*)/m,
  )?.[1];
  return list
    ? [...list.matchAll(/^[ \t]+-[ \t]+(.+)$/gm)].map((match) =>
        match[1].trim(),
      )
    : [];
}

export function updateIndexes(sdlcRoot = defaultSdlcRoot) {
  for (const [directory, heading] of sections) {
    const path = resolve(sdlcRoot, directory);
    const rows = readdirSync(path)
      .filter((name) => name !== "index.md" && name.endsWith(".md"))
      .map((name) => {
        const contents = readFileSync(resolve(path, name), "utf8");
        return {
          name,
          id: field(contents, "id"),
          title: field(contents, "title"),
          status: field(contents, "status"),
          created: field(contents, "created"),
          owners: parseOwners(contents),
        };
      })
      .sort((left, right) =>
        `${left.created}\\0${left.title}`.localeCompare(
          `${right.created}\\0${right.title}`,
        ),
      )
      .map(
        (document) =>
          `| [${document.id}](./${document.name}) | ${document.title} | ${document.status} | ${document.created} | ${document.owners.join(", ")} |`,
      );
    writeFileSync(
      resolve(path, "index.md"),
      `# ${heading}\n\n| Key | Title | Status | Created | Owners |\n| --- | --- | --- | --- | --- |\n${rows.join("\n")}\n`,
    );
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  updateIndexes();
  console.log("Updated SDLC type indexes.");
}
