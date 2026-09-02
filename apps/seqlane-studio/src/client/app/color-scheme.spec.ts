import { describe, expect, it } from "vitest";
import { applyStudioColorScheme } from "./color-scheme.js";

describe("applyStudioColorScheme", () => {
  it("marks the document root with the selected scheme", () => {
    const root = { dataset: {} } as Pick<HTMLElement, "dataset">;

    applyStudioColorScheme(root, "dark");

    expect(root.dataset.theme).toBe("dark");
  });
});
