import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const sdlcRoot = resolve(repositoryRoot, "docs", "sdlc");
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const filenamePattern = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const idPattern = /^(brd|prd|rfc|adr|spec|task)\.[a-z0-9]+(?:-[a-z0-9]+)*$/;
const requiredFields = [
  "id",
  "title",
  "status",
  "owners",
  "created",
  "updated",
  "upstream",
  "supersedes",
];
const sections = {
  brd: ["BRD", ["draft", "review", "accepted", "superseded"]],
  prd: ["PRD", ["draft", "review", "accepted", "superseded"]],
  rfcs: ["RFC", ["proposed", "accepted", "rejected", "superseded"]],
  adrs: ["ADR", ["proposed", "accepted", "rejected", "superseded"]],
  specs: ["SPEC", ["draft", "active", "superseded"]],
  tasks: [
    "TASK",
    ["planned", "in-progress", "blocked", "completed", "cancelled"],
  ],
};
const knownFields = new Set(requiredFields);
const errors = [];

function report(path, message) {
  errors.push(`${relative(repositoryRoot, path)}: ${message}`);
}

function parseFrontmatter(path, contents) {
  if (!contents.startsWith("---\n")) {
    report(path, "missing YAML frontmatter");
    return {};
  }
  const end = contents.indexOf("\n---\n", 4);
  if (end === -1) {
    report(path, "frontmatter is not closed with ---");
    return {};
  }

  const metadata = {};
  let currentList;
  for (const [index, line] of contents.slice(4, end).split("\n").entries()) {
    const item = line.match(/^\s+-\s+(.+)$/);
    if (item && currentList) {
      metadata[currentList].push(item[1].trim());
      continue;
    }
    const field = line.match(/^([a-z_]+):(?:\s*(.*))?$/);
    if (!field) {
      report(path, `invalid frontmatter line ${index + 2}: ${line}`);
      currentList = undefined;
      continue;
    }
    const [, name, raw = ""] = field;
    if (!knownFields.has(name))
      report(path, `unknown frontmatter field '${name}'`);
    if (raw.trim() === "[]" || raw.trim() === "") {
      metadata[name] = [];
      currentList = name;
    } else {
      metadata[name] = raw.trim();
      currentList = undefined;
    }
  }
  return metadata;
}

function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.name.endsWith(".md") ? [path] : [];
  });
}

const documents = [];
for (const [directory, [type, statuses]] of Object.entries(sections)) {
  const path = resolve(sdlcRoot, directory);
  const indexContents = readFileSync(resolve(path, "index.md"), "utf8");
  for (const name of readdirSync(path).filter(
    (entry) => entry !== "index.md" && entry.endsWith(".md"),
  )) {
    const documentPath = resolve(path, name);
    const contents = readFileSync(documentPath, "utf8");
    const metadata = parseFrontmatter(documentPath, contents);

    for (const field of requiredFields) {
      if (!(field in metadata))
        report(documentPath, `missing required frontmatter field '${field}'`);
    }
    if (typeof metadata.id === "string" && !idPattern.test(metadata.id)) {
      report(documentPath, `invalid ID '${metadata.id}'`);
    }
    if (
      typeof metadata.id === "string" &&
      !metadata.id.startsWith(`${type.toLowerCase()}.`)
    ) {
      report(
        documentPath,
        `${metadata.id} is in the wrong type directory '${directory}'`,
      );
    }
    if (!filenamePattern.test(name))
      report(
        documentPath,
        "filename must use <YYYY-MM-DD>-<lowercase-kebab-title>.md",
      );
    if (typeof metadata.title !== "string" || metadata.title.length === 0) {
      report(documentPath, "title must be a non-empty string");
    }
    if (!statuses.includes(metadata.status)) {
      report(
        documentPath,
        `status '${metadata.status}' is not allowed for ${type}`,
      );
    }
    if (!Array.isArray(metadata.owners) || metadata.owners.length === 0) {
      report(documentPath, "owners must be a non-empty list");
    }
    for (const field of ["created", "updated"]) {
      if (
        typeof metadata[field] !== "string" ||
        !datePattern.test(metadata[field])
      ) {
        report(documentPath, `${field} must use YYYY-MM-DD`);
      }
    }
    if (
      typeof metadata.created === "string" &&
      filenamePattern.test(name) &&
      !name.startsWith(`${metadata.created}-`)
    ) {
      report(documentPath, "filename date must match frontmatter 'created'");
    }
    for (const field of ["upstream", "supersedes"]) {
      if (!Array.isArray(metadata[field]))
        report(documentPath, `${field} must be a list`);
    }
    if (
      Array.isArray(metadata.supersedes) &&
      metadata.supersedes.includes(metadata.id)
    ) {
      report(documentPath, "a document cannot supersede itself");
    }
    if (
      ["PRD", "RFC", "SPEC", "TASK"].includes(type) &&
      !/^## Traceability\s*$/m.test(contents)
    ) {
      report(documentPath, "missing Traceability section");
    }
    if (!indexContents.includes(`./${name}`))
      report(documentPath, `${directory}/index.md omits this document`);

    documents.push({ path: documentPath, contents, metadata });
  }
}

const byId = new Map();
const canonicalPaths = new Set(documents.map((document) => document.path));
for (const path of markdownFiles(sdlcRoot)) {
  if (/^\d{4}-\d{2}-\d{2}-/.test(basename(path)) && !canonicalPaths.has(path)) {
    report(path, "SDLC document is outside its canonical type directory");
  }
}

for (const document of documents) {
  if (typeof document.metadata.id !== "string") continue;
  const duplicate = byId.get(document.metadata.id);
  if (duplicate) {
    report(
      document.path,
      `duplicate ID '${document.metadata.id}' also used by ${relative(repositoryRoot, duplicate.path)}`,
    );
  } else {
    byId.set(document.metadata.id, document);
  }
}

for (const document of documents) {
  for (const field of ["upstream", "supersedes"]) {
    if (!Array.isArray(document.metadata[field])) continue;
    for (const id of document.metadata[field]) {
      if (!byId.has(id))
        report(document.path, `${field} references missing document '${id}'`);
    }
  }
}

for (const path of markdownFiles(sdlcRoot)) {
  if (path.includes(`${sdlcRoot}/templates/`)) continue;
  const contents = readFileSync(path, "utf8");
  for (const match of contents.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].split("#", 1)[0];
    if (!target || /^(?:https?:|mailto:|#)/.test(target)) continue;
    const resolvedTarget = resolve(dirname(path), decodeURI(target));
    if (!existsSync(resolvedTarget)) {
      report(path, `broken relative Markdown link '${match[1]}'`);
      continue;
    }
    if (
      statSync(resolvedTarget).isDirectory() &&
      !existsSync(resolve(resolvedTarget, "index.md"))
    ) {
      report(path, `linked directory '${target}' has no index.md`);
    }
  }
}

if (errors.length > 0) {
  console.error(`SDLC validation failed with ${errors.length} error(s):`);
  for (const error of errors.sort()) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`SDLC validation passed (${documents.length} documents).`);
}
