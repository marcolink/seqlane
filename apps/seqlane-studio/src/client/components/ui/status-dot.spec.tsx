import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusDot } from "./status-dot.js";

describe("StatusDot", () => {
  it("renders a decorative live-state indicator with its semantic tone", () => {
    const markup = renderToStaticMarkup(<StatusDot tone="active" pulse />);

    expect(markup).toContain("studio-status-dot--active");
    expect(markup).toContain("studio-status-dot--pulse");
    expect(markup).toContain('aria-hidden="true"');
  });
});
