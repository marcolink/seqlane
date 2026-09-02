import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Notice } from "./notice.js";

describe("Notice", () => {
  it("renders a semantic error notice", () => {
    const markup = renderToStaticMarkup(
      <Notice tone="error" role="alert">
        Studio disconnected.
      </Notice>,
    );

    expect(markup).toContain("studio-notice--error");
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Studio disconnected.");
  });
});
