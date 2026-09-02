import { describe, expect, it } from "vitest";
import {
  sidebarWidthAfterDrag,
  sidebarWidthBounds,
} from "./sidebar-resizing.js";

describe("sidebar resizing", () => {
  it("keeps the current sidebar widths as the lower bounds", () => {
    expect(
      sidebarWidthBounds({
        sidebar: "runs",
        viewportWidth: 1_280,
        otherSidebarWidth: 352,
      }),
    ).toEqual({ maximum: 352, minimum: 240 });
    expect(
      sidebarWidthBounds({
        sidebar: "inspector",
        viewportWidth: 1_280,
        otherSidebarWidth: 240,
      }),
    ).toEqual({ maximum: 464, minimum: 352 });
  });

  it("clamps dragging to sidebar and graph minimum widths", () => {
    const runsBounds = { minimum: 240, maximum: 352 };
    const inspectorBounds = { minimum: 352, maximum: 464 };

    expect(sidebarWidthAfterDrag("runs", 240, -96, runsBounds)).toBe(240);
    expect(sidebarWidthAfterDrag("runs", 240, 480, runsBounds)).toBe(352);
    expect(
      sidebarWidthAfterDrag("inspector", 352, 96, inspectorBounds),
    ).toBe(352);
    expect(
      sidebarWidthAfterDrag("inspector", 352, -480, inspectorBounds),
    ).toBe(464);
  });
});
