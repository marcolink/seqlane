import { describe, expect, it } from "vitest";
import { parseGitPaths, parseScopedGitPatches } from "./review-git-records.js";

const header = `:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} M`;

describe("raw Git evidence records", () => {
  it("parses NUL paths without splitting tabs, newlines, or BOM bytes", () => {
    expect(
      parseGitPaths(
        Buffer.from("M\0tab\tname.ts\0A\0line\nname.ts\0D\0\ufeffname.ts\0"),
      ),
    ).toEqual(["tab\tname.ts", "line\nname.ts", "\ufeffname.ts"]);
  });

  it.each([
    "M\0name.ts",
    "M\0",
    "R100\0old.ts\0new.ts\0",
    "M\0a.ts\0M\0a.ts\0",
    "A\0../bad\0",
  ])("rejects malformed or ambiguous records %j", (output) => {
    expect(() => parseGitPaths(Buffer.from(output))).toThrow();
  });

  it("rejects invalid UTF-8 before membership or Git argv", () => {
    expect(() => parseGitPaths(Buffer.from([77, 0, 255, 0]))).toThrow("UTF-8");
  });

  it("binds a patch using raw paths rather than quoted patch headers", () => {
    const patch =
      'diff --git "a/line\\nname.ts" "b/line\\nname.ts"\n@@ -1 +1 @@\n-old\n+new\n';
    expect(
      parseScopedGitPatches(
        Buffer.from(`${header}\0line\nname.ts\0\0${patch}`),
        ["line\nname.ts"],
      ),
    ).toMatchObject([
      {
        patch,
        hunkCount: 1,
        treeChange: {
          path: "line\nname.ts",
          evidenceForm: "pr-patch",
          status: "M",
        },
      },
    ]);
  });

  it("rejects missing, extra, or mismatched patch paths", () => {
    const patch = "diff --git a/a.ts b/a.ts\n";
    for (const output of [
      patch,
      `${header}\0other.ts\0\0${patch}`,
      `${header}\0a.ts\0${header}\0b.ts\0\0${patch}`,
    ]) {
      expect(() =>
        parseScopedGitPatches(Buffer.from(output), ["a.ts"]),
      ).toThrow();
    }
  });

  it("binds every grouped patch to the exact raw inventory", () => {
    const first =
      "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+diff --git a/other.ts b/other.ts\n";
    const second =
      "diff --git a/b.ts b/b.ts\nold mode 100644\nnew mode 100755\n";
    const result = parseScopedGitPatches(
      Buffer.from(`${header}\0a.ts\0${header}\0b.ts\0\0${first}${second}`),
      ["b.ts", "a.ts"],
    );
    expect(result.map(({ treeChange }) => treeChange.path)).toEqual([
      "a.ts",
      "b.ts",
    ]);
    expect(result.map(({ patch }) => patch)).toEqual([first, second]);
    expect(result.map(({ hunkCount }) => hunkCount)).toEqual([1, 0]);
  });

  it.each([
    "diff --git a/a.ts b/a.ts\n",
    "diff --git a/a.ts b/a.ts\ndiff --git a/other.ts b/other.ts\n",
    "diff --git a/a.ts b/a.ts\ndiff --git a/a.ts b/a.ts\ndiff --git a/b.ts b/b.ts\n",
  ])(
    "rejects missing, unknown, or duplicated grouped patch headers",
    (patch) => {
      expect(() =>
        parseScopedGitPatches(
          Buffer.from(`${header}\0a.ts\0${header}\0b.ts\0\0${patch}`),
          ["a.ts", "b.ts"],
        ),
      ).toThrow();
    },
  );

  it("rejects duplicated raw records and selected paths", () => {
    const patch = "diff --git a/a.ts b/a.ts\n";
    expect(() =>
      parseScopedGitPatches(
        Buffer.from(`${header}\0a.ts\0${header}\0a.ts\0\0${patch}`),
        ["a.ts", "b.ts"],
      ),
    ).toThrow();
    expect(() =>
      parseScopedGitPatches(Buffer.from(`${header}\0a.ts\0\0${patch}`), [
        "a.ts",
        "a.ts",
      ]),
    ).toThrow();
  });

  it("keeps both adjacent patches for one file-type change", () => {
    const patch =
      "diff --git a/a.ts b/a.ts\ndeleted file mode 100644\ndiff --git a/a.ts b/a.ts\nnew file mode 120000\n";
    const result = parseScopedGitPatches(
      Buffer.from(`${header.slice(0, -1)}T\0a.ts\0\0${patch}`),
      ["a.ts"],
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.patch).toBe(patch);
    expect(result[0]?.treeChange.status).toBe("T");
    expect(() =>
      parseScopedGitPatches(
        Buffer.from(
          `${header.slice(0, -1)}T\0a.ts\0\0${patch}diff --git a/a.ts b/a.ts\n`,
        ),
        ["a.ts"],
      ),
    ).toThrow();
  });
});
