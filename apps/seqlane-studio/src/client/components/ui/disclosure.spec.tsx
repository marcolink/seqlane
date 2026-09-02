import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Disclosure } from "./disclosure.js";

describe("Disclosure", () => {
  it("renders a closed semantic disclosure by default", () => {
    const markup = renderToStaticMarkup(
      <Disclosure summary="Event details">
        <p>Full event payload</p>
      </Disclosure>,
    );

    expect(markup).toContain('<details class="studio-disclosure">');
    expect(markup).toContain("<summary>Event details</summary>");
    expect(markup).not.toContain(" open");
    expect(markup).toContain("Full event payload");
  });
});
