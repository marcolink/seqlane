import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DescriptionList } from "./description-list.js";

describe("DescriptionList", () => {
  it("renders labelled metadata as a description list", () => {
    const markup = renderToStaticMarkup(
      <DescriptionList
        items={[{ term: "Invocation", description: "invocation-1" }]}
      />,
    );

    expect(markup).toContain("studio-description-list");
    expect(markup).toContain("<dt>Invocation</dt>");
    expect(markup).toContain("<dd>invocation-1</dd>");
  });
});
