import {
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { resolveWorkspaceIdentity } from "./workspace-identity.js";

describe("workspace identity resolution", () => {
  it("resolves equivalent workspace paths to one canonical identity", async () => {
    const directory = mkdtempSync(join(tmpdir(), "seqlane-workspace-"));
    const alias = `${directory}-alias`;
    symlinkSync(directory, alias);

    try {
      const direct = await resolveWorkspaceIdentity(directory);
      const throughAlias = await resolveWorkspaceIdentity(alias);

      expect(direct).toEqual(throughAlias);
      expect(direct).toEqual({ path: realpathSync(directory) });
    } finally {
      unlinkSync(alias);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects an unresolved configured workspace", async () => {
    await expect(
      resolveWorkspaceIdentity("/workspace/that-does-not-exist"),
    ).rejects.toMatchObject({ name: "WorkspaceResolutionError" });
  });
});
