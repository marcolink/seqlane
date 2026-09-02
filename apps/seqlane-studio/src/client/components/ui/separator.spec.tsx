import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Separator } from "./separator.js";

describe("Separator", () => {
  it("renders a semantic horizontal separator", () => {
    const markup = renderToStaticMarkup(<Separator />);

    expect(markup).toContain("<hr");
    expect(markup).toContain("studio-separator");
  });
});
