import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { updateIndexes } from "./update-sdlc-indexes.mjs";
import { validateSdlc } from "./validate-sdlc.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const sectionNames = ["brd", "prd", "rfcs", "adrs", "specs", "tasks"];

function emptyIndex() {
  return "# Index\n\n| Key | Title | Status | Created | Owners |\n| --- | --- | --- | --- | --- |\n";
}

function createFixture() {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "seqlane-sdlc-test-"));
  const sdlcRoot = join(fixtureRoot, "docs", "sdlc");
  for (const section of sectionNames) {
    const directory = join(sdlcRoot, section);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "index.md"), emptyIndex());
  }
  return { fixtureRoot, sdlcRoot };
}

function writeDocument(
  sdlcRoot,
  section,
  {
    id,
    title,
    status = "accepted",
    created = "2026-01-01",
    updated = created,
    owners = ["core"],
    upstream = [],
    supersedes = [],
    traceability = "",
    filename = `${created}-${id.split(".")[1]}.md`,
  },
) {
  const contents = `---
id: ${id}
title: ${title}
status: ${status}
owners:
${owners.map((owner) => `  - ${owner}`).join("\n")}
created: ${created}
updated: ${updated}
upstream:${upstream.length ? `\n${upstream.map((value) => `  - ${value}`).join("\n")}` : " []"}
supersedes:${supersedes.length ? `\n${supersedes.map((value) => `  - ${value}`).join("\n")}` : " []"}
---

# ${title}

${section === "prd" ? "## Traceability\n\n" : ""}${traceability}`;
  const path = join(sdlcRoot, section, filename);
  writeFileSync(path, contents);
  return { filename, path };
}

function writeIndexRow(sdlcRoot, section, row) {
  writeFileSync(join(sdlcRoot, section, "index.md"), `${emptyIndex()}${row}\n`);
}

function removeFixture(fixtureRoot) {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

test("rejects stale index metadata and mismatched Traceability links", () => {
  const { fixtureRoot, sdlcRoot } = createFixture();
  try {
    const brd = writeDocument(sdlcRoot, "brd", {
      id: "brd.example",
      title: "Example business requirement",
    });
    const alternateBrd = writeDocument(sdlcRoot, "brd", {
      id: "brd.alternate",
      title: "Alternate business requirement",
    });
    const prd = writeDocument(sdlcRoot, "prd", {
      id: "prd.example",
      title: "Example product requirement",
      upstream: ["brd.example"],
      traceability: `- [brd.example: Example business requirement](../brd/${alternateBrd.filename})\n`,
    });

    writeIndexRow(
      sdlcRoot,
      "brd",
      `| [brd.example](./${brd.filename}) | Stale title | accepted | 2026-01-01 | core |\n| [brd.alternate](./${alternateBrd.filename}) | Alternate business requirement | accepted | 2026-01-01 | core |`,
    );
    writeIndexRow(
      sdlcRoot,
      "prd",
      `| [prd.example](./${prd.filename}) | Example product requirement | accepted | 2026-01-01 | core |`,
    );

    const errors = validateSdlc({ repositoryRoot: fixtureRoot, sdlcRoot });

    assert.ok(errors.some((error) => error.includes("index title")));
    assert.ok(
      errors.some(
        (error) =>
          error.includes("Traceability link") && error.includes("brd.example"),
      ),
    );
  } finally {
    removeFixture(fixtureRoot);
  }
});

test("renders all owners in generated indexes", () => {
  const { fixtureRoot, sdlcRoot } = createFixture();
  try {
    writeDocument(sdlcRoot, "brd", {
      id: "brd.multi-owner",
      title: "Multi-owner requirement",
      owners: ["core", "docs"],
    });

    updateIndexes(sdlcRoot);

    assert.match(
      readFileSync(join(sdlcRoot, "brd", "index.md"), "utf8"),
      /\| core, docs \|/,
    );
  } finally {
    removeFixture(fixtureRoot);
  }
});

test("documents runnable Codex commands with their adapter workspace", () => {
  const readme = readFileSync(join(repositoryRoot, "README.md"), "utf8");
  const shellBlocks = [...readme.matchAll(/```sh\n([\s\S]*?)```/g)].map(
    (match) => match[1],
  );

  assert.ok(
    shellBlocks.some(
      (block) =>
        block.includes("seqlane run ./workflow.ts") &&
        block.includes("--adapter codex") &&
        block.includes('--workspace "$PWD"'),
    ),
    "README must include a runnable Codex adapter command with an explicit workspace",
  );

  const workflowReadme = readFileSync(
    join(repositoryRoot, "workflows/read-context/README.md"),
    "utf8",
  );
  const workflowShellBlocks = [
    ...workflowReadme.matchAll(/```sh\n([\s\S]*?)```/g),
  ].map((match) => match[1]);

  assert.ok(
    workflowShellBlocks.some(
      (block) =>
        block.includes("seqlane run ./workflows/read-context/workflow.ts") &&
        block.includes("--adapter codex") &&
        block.includes('--workspace "$PWD"'),
    ),
    "Read-context README must include the Codex adapter and explicit workspace",
  );
});

test("preserves partial historical supersession relationships", () => {
  const executorNeutralAdr = readFileSync(
    join(
      repositoryRoot,
      "docs/sdlc/adrs/2026-09-02-executor-neutral-workflow-authoring.md",
    ),
    "utf8",
  );
  const studioLifecycleAdr = readFileSync(
    join(
      repositoryRoot,
      "docs/sdlc/adrs/2026-09-02-local-development-studio-trust-and-lifecycle.md",
    ),
    "utf8",
  );

  assert.match(
    executorNeutralAdr,
    /^supersedes:\n {2}- adr\.opencode-executor-integration$/m,
  );
  assert.match(
    executorNeutralAdr,
    /supersedes only the workflow-authoring portion/i,
  );
  assert.match(
    studioLifecycleAdr,
    /^supersedes:\n {2}- adr\.local-read-only-execution-studio$/m,
  );
  assert.match(
    studioLifecycleAdr,
    /supersedes only the access-boundary, session-discovery, and lifecycle\s+details/i,
  );
});

test("rejects invalid dates, numeric IDs, and mismatched filename slugs", () => {
  const { fixtureRoot, sdlcRoot } = createFixture();
  try {
    writeDocument(sdlcRoot, "brd", {
      id: "brd.invalid-date",
      title: "Invalid date",
      created: "2026-02-30",
    });
    writeDocument(sdlcRoot, "brd", {
      id: "brd.123",
      title: "Numeric ID",
    });
    writeDocument(sdlcRoot, "brd", {
      id: "brd.expected-slug",
      title: "Mismatched slug",
      filename: "2026-01-01-wrong-slug.md",
    });

    const errors = validateSdlc({ repositoryRoot: fixtureRoot, sdlcRoot });

    assert.ok(
      errors.some((error) =>
        error.includes("created must be a valid calendar date"),
      ),
    );
    assert.ok(errors.some((error) => error.includes("invalid ID 'brd.123'")));
    assert.ok(
      errors.some((error) => error.includes("filename slug 'wrong-slug'")),
    );
  } finally {
    removeFixture(fixtureRoot);
  }
});
