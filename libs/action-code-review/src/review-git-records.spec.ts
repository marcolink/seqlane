import { describe, expect, it } from "vitest";
import { parseGitPaths, parseScopedGitPatch } from "./review-git-records.js";

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
      parseScopedGitPatch(
        Buffer.from(`${header}\0line\nname.ts\0\0${patch}`),
        "line\nname.ts",
      ),
    ).toMatchObject({
      patch,
      hunkCount: 1,
      treeChange: {
        path: "line\nname.ts",
        evidenceForm: "review-patch",
        status: "M",
      },
    });
  });

  it("rejects missing, extra, or mismatched patch paths", () => {
    const patch = "diff --git a/a.ts b/a.ts\n";
    for (const output of [
      patch,
      `${header}\0other.ts\0\0${patch}`,
      `${header}\0a.ts\0${header}\0b.ts\0\0${patch}`,
    ]) {
      expect(() => parseScopedGitPatch(Buffer.from(output), "a.ts")).toThrow();
    }
  });
});
