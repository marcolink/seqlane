import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Tooltip } from "./tooltip.js";

describe("Tooltip", () => {
  it("adds supplemental context to a labelled trigger", () => {
    const markup = renderToStaticMarkup(
      <Tooltip text="View the graph without surrounding panels">
        <button type="button" aria-label="Enter graph fullscreen">
          Expand
        </button>
      </Tooltip>,
    );

    expect(markup).toContain('aria-label="Enter graph fullscreen"');
    expect(markup).toContain("aria-describedby=");
    expect(markup).toContain('role="tooltip"');
    expect(markup).toContain("View the graph without surrounding panels");
  });

  it("can align its content with the edge of a narrow trigger area", () => {
    const markup = renderToStaticMarkup(
      <Tooltip align="end" text="Use the full workspace width">
        <button type="button" aria-label="Close runs drawer">
          Close
        </button>
      </Tooltip>,
    );

    expect(markup).toContain("studio-tooltip__content--align-end");
  });
});
