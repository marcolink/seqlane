import { X } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button, IconButton } from "./button.js";

describe("Studio action buttons", () => {
  it("renders labelled actions as non-submitting buttons with an appearance", () => {
    const markup = renderToStaticMarkup(
      <Button appearance="primary">Play</Button>,
    );

    expect(markup).toContain('type="button"');
    expect(markup).toContain("studio-button--primary");
    expect(markup).toContain(">Play</button>");
  });

  it("requires a label for icon-only actions", () => {
    const markup = renderToStaticMarkup(
      <IconButton aria-label="Close drawer">
        <X aria-hidden="true" />
      </IconButton>,
    );

    expect(markup).toContain('aria-label="Close drawer"');
    expect(markup).toContain("studio-icon-button");
  });
});
