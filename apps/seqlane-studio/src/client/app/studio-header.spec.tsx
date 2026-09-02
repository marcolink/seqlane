import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StudioHeader } from "./studio-header.js";

describe("StudioHeader", () => {
  it("renders the current colour scheme action and connection state", () => {
    const markup = renderToStaticMarkup(
      <StudioHeader
        colorScheme="dark"
        connected
        onToggleColorScheme={() => undefined}
      />,
    );

    expect(markup).toContain("Seqlane Studio");
    expect(markup).toContain('aria-label="Switch to light scheme"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain("Live");
  });
});
