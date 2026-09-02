import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SidebarResizeHandle } from "./sidebar-resize-handle.js";

describe("SidebarResizeHandle", () => {
  it("exposes a labelled vertical separator with width bounds", () => {
    const markup = renderToStaticMarkup(
      <SidebarResizeHandle
        bounds={{ minimum: 240, maximum: 352 }}
        onResize={vi.fn()}
        sidebar="runs"
        width={240}
      />,
    );

    expect(markup).toContain('role="separator"');
    expect(markup).toContain('aria-label="Resize runs drawer"');
    expect(markup).toContain('aria-valuemin="240"');
    expect(markup).toContain('aria-valuemax="352"');
  });
});
