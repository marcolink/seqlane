import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Panel } from "./panel.js";

describe("Panel compound component", () => {
  it("composes a semantic root and shared header/body parts", () => {
    const markup = renderToStaticMarkup(
      <Panel as="nav" aria-label="Runs">
        <Panel.Header>
          <Panel.Title>Runs</Panel.Title>
        </Panel.Header>
        <Panel.Body>Content</Panel.Body>
      </Panel>,
    );

    expect(markup).toContain('<nav aria-label="Runs"');
    expect(markup).toContain("flex items-center justify-between gap-3");
    expect(markup).toContain("<h2");
    expect(markup).toContain("Content");
  });
});
