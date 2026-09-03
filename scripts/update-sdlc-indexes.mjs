import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "docs", "sdlc");
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

function owner(contents) {
  return contents.match(/^owners:\s*\n\s+-\s+(.+)$/m)?.[1].trim() ?? "";
}

for (const [directory, heading] of sections) {
  const path = resolve(root, directory);
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
        owner: owner(contents),
      };
    })
    .sort((left, right) =>
      `${left.created}\\0${left.title}`.localeCompare(
        `${right.created}\\0${right.title}`,
      ),
    )
    .map(
      (document) =>
        `| [${document.id}](./${document.name}) | ${document.title} | ${document.status} | ${document.created} | ${document.owner} |`,
    );
  writeFileSync(
    resolve(path, "index.md"),
    `# ${heading}\n\n| Key | Title | Status | Created | Owners |\n| --- | --- | --- | --- | --- |\n${rows.join("\n")}\n`,
  );
}

console.log("Updated SDLC type indexes.");
