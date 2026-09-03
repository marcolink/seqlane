import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRepositoryRoot = resolve(import.meta.dirname, "..");
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

function parseFrontmatter(path, contents, report) {
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

function parseIndexRows(path, contents, report) {
  const rows = [];
  for (const [index, line] of contents.split("\n").entries()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || trimmed === "|") continue;
    const cells = trimmed
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
    if (cells[0] === "Key") continue;
    if (cells.every((cell) => /^-+$/.test(cell))) continue;
    if (cells.length !== 5) {
      report(path, `malformed index row at line ${index + 1}`);
      continue;
    }
    const link = cells[0].match(/^\[([^\]]+)\]\(\.\/([^)]+)\)$/);
    if (!link) {
      report(
        path,
        `index row at line ${index + 1} has an invalid document link`,
      );
      continue;
    }
    rows.push({
      id: link[1],
      name: link[2],
      title: cells[1],
      status: cells[2],
      created: cells[3],
      owners: cells[4],
    });
  }
  return rows;
}

function traceabilityLinks(contents) {
  const heading = /^## Traceability\s*$/m.exec(contents);
  if (!heading) return [];
  const section = contents.slice(heading.index + heading[0].length);
  const nextHeading = section.search(/^## /m);
  const body = nextHeading === -1 ? section : section.slice(0, nextHeading);
  return [...body.matchAll(/\[([^\]]+)\]\(([^)#]+)(?:#[^)]+)?\)/g)].map(
    ([, label, target]) => ({
      id: label.match(
        /^(?:brd|prd|rfc|adr|spec|task)\.[a-z0-9]+(?:-[a-z0-9]+)*/,
      )?.[0],
      target,
    }),
  );
}

export function validateSdlc({
  repositoryRoot = defaultRepositoryRoot,
  sdlcRoot = resolve(repositoryRoot, "docs", "sdlc"),
} = {}) {
  const errors = [];
  const report = (path, message) => {
    errors.push(`${relative(repositoryRoot, path)}: ${message}`);
  };
  const documents = [];
  const indexes = [];

  for (const [directory, [type, statuses]] of Object.entries(sections)) {
    const path = resolve(sdlcRoot, directory);
    const indexPath = resolve(path, "index.md");
    if (!existsSync(indexPath)) {
      report(indexPath, "missing type index");
    } else {
      indexes.push({
        directory,
        path,
        contents: readFileSync(indexPath, "utf8"),
      });
    }
    for (const name of readdirSync(path).filter(
      (entry) => entry !== "index.md" && entry.endsWith(".md"),
    )) {
      const documentPath = resolve(path, name);
      const contents = readFileSync(documentPath, "utf8");
      const metadata = parseFrontmatter(documentPath, contents, report);

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

      documents.push({ directory, path: documentPath, contents, metadata });
    }
  }

  const canonicalPaths = new Set(documents.map((document) => document.path));
  const documentsByPath = new Map(
    documents.map((document) => [document.path, document]),
  );
  for (const path of markdownFiles(sdlcRoot)) {
    if (
      /^\d{4}-\d{2}-\d{2}-/.test(basename(path)) &&
      !canonicalPaths.has(path)
    ) {
      report(path, "SDLC document is outside its canonical type directory");
    }
  }

  const byId = new Map();
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

  for (const { directory, path, contents } of indexes) {
    const rows = parseIndexRows(resolve(path, "index.md"), contents, report);
    const indexedPaths = new Set();
    for (const row of rows) {
      const documentPath = resolve(path, row.name);
      const document = documentsByPath.get(documentPath);
      if (!document) {
        report(
          resolve(path, "index.md"),
          `index references missing document '${row.name}'`,
        );
        continue;
      }
      if (indexedPaths.has(documentPath)) {
        report(
          resolve(path, "index.md"),
          `index lists document '${row.name}' more than once`,
        );
        continue;
      }
      indexedPaths.add(documentPath);
      const expected = {
        id: document.metadata.id,
        title: document.metadata.title,
        status: document.metadata.status,
        created: document.metadata.created,
        owners: Array.isArray(document.metadata.owners)
          ? document.metadata.owners.join(", ")
          : "",
      };
      for (const field of ["id", "title", "status", "created", "owners"]) {
        if (row[field] !== expected[field]) {
          report(
            resolve(path, "index.md"),
            `index ${field} for '${document.metadata.id}' is '${row[field]}' but document has '${expected[field]}'`,
          );
        }
      }
    }
    for (const document of documents.filter(
      (candidate) => candidate.directory === directory,
    )) {
      if (!indexedPaths.has(document.path)) {
        report(
          resolve(path, "index.md"),
          `index omits document '${basename(document.path)}'`,
        );
      }
    }
  }

  for (const document of documents) {
    const upstream = Array.isArray(document.metadata.upstream)
      ? document.metadata.upstream
      : [];
    if (upstream.length === 0) continue;
    const links = traceabilityLinks(document.contents);
    for (const id of upstream) {
      const target = byId.get(id);
      if (!target) continue;
      const matchingLinks = links.filter((link) => link.id === id);
      if (matchingLinks.length === 0) {
        report(document.path, `Traceability omits upstream '${id}'`);
        continue;
      }
      if (
        !matchingLinks.some(
          (link) =>
            resolve(dirname(document.path), link.target) === target.path,
        )
      ) {
        report(
          document.path,
          `Traceability link for upstream '${id}' does not target ${relative(repositoryRoot, target.path)}`,
        );
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

  return errors.sort();
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const errors = validateSdlc();
  if (errors.length > 0) {
    console.error(`SDLC validation failed with ${errors.length} error(s):`);
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    const documentCount = Object.keys(sections).reduce(
      (count, directory) =>
        count +
        readdirSync(
          resolve(defaultRepositoryRoot, "docs", "sdlc", directory),
        ).filter((name) => name !== "index.md" && name.endsWith(".md")).length,
      0,
    );
    console.log(`SDLC validation passed (${documentCount} documents).`);
  }
}
