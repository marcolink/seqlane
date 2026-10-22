import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  auditArchive,
  auditGenerated,
  auditSource,
} from "./verify-runtime-boundary.mjs";

const retiredName = String.fromCodePoint(109, 97, 115, 116, 114, 97);

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "seqlane-runtime-audit-"));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("source audit rejects mixed-case names and content, including new files", () => {
  fixture((root) => {
    execFileSync("git", ["init", "--quiet", root]);
    writeFileSync(join(root, "contract.ts"), "export const valid = true;\n");
    execFileSync("git", ["-C", root, "add", "contract.ts"]);
    assert.equal(auditSource(root), 1);
    writeFileSync(join(root, "new.ts"), retiredName.toUpperCase());
    assert.throws(() => auditSource(root), /Retired runtime evidence: new.ts/);
    rmSync(join(root, "new.ts"));
    const name = `${retiredName.toUpperCase()}.ts`;
    writeFileSync(join(root, name), "export {};\n");
    assert.throws(() => auditSource(root), /Retired runtime evidence/);
    rmSync(join(root, name));
    // Scheduled deletions must not keep a retired path alive in the index.
    rmSync(join(root, "contract.ts"));
    assert.equal(auditSource(root), 0);
  });
});

test("archive audit inspects expanded metadata and contents", () => {
  fixture((root) => {
    const contents = join(root, "package");
    mkdirSync(contents);
    const archive = join(root, "runtime.tgz");
    writeFileSync(join(contents, "index.js"), "export {};\n");
    const pack = () =>
      execFileSync("tar", ["-czf", archive, "-C", root, "package"]);
    pack();
    assert.doesNotThrow(() => auditArchive(root, archive));
    writeFileSync(
      join(contents, "index.js.map"),
      JSON.stringify({ sources: [retiredName.toUpperCase()] }),
    );
    pack();
    assert.throws(
      () => auditArchive(root, archive),
      /Retired runtime evidence/,
    );
    rmSync(join(contents, "index.js.map"));
    writeFileSync(join(contents, `${retiredName}.js`), "export {};\n");
    pack();
    assert.throws(
      () => auditArchive(root, archive),
      /Retired runtime evidence/,
    );
  });
});

test("complete audit requires built packages and all release archives", () => {
  fixture((root) => {
    for (const family of ["actions", "apps", "libs", "workflows"])
      mkdirSync(join(root, family));
    const library = join(root, "libs/core");
    mkdirSync(library);
    writeFileSync(join(library, "package.json"), '{"name":"fixture"}');
    assert.throws(
      () => auditGenerated(root, true),
      /Missing built distribution/,
    );
    mkdirSync(join(library, "dist"));
    writeFileSync(join(library, "dist/index.d.ts"), "export {};\n");
    assert.throws(
      () => auditGenerated(root, true),
      /Missing production archive/,
    );
    writeFileSync(join(library, "dist/old.js.map"), retiredName);
    assert.throws(() => auditGenerated(root), /Retired runtime evidence/);
  });
});
