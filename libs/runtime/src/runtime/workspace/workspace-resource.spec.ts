import { describe, expect, it } from "vitest";
import type { WorkspaceIdentityRegistry } from "./workspace-identity.js";
import { createWorkspaceResources } from "./workspace-resource.js";

describe("checkout workspace resources", () => {
  it("maps file-accessing tasks in one checkout to one resource", () => {
    const identities: WorkspaceIdentityRegistry = new Map([
      ["inspect-package", { path: "/checkout" }],
      ["test-package", { path: "/checkout" }],
    ]);

    const resources = createWorkspaceResources(identities);

    expect(resources.get("inspect-package")).toEqual({ key: "/checkout" });
    expect(resources.get("test-package")).toBe(
      resources.get("inspect-package"),
    );
  });
});
