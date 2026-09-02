import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CodeBlock, ValueCard } from "./value-card.js";

describe("ValueCard", () => {
  it("groups a titled value and its formatted code content", () => {
    const markup = renderToStaticMarkup(
      <ValueCard heading="Input">
        <CodeBlock>{'{"topic":"Studio"}'}</CodeBlock>
      </ValueCard>,
    );

    expect(markup).toContain("studio-value-card");
    expect(markup).toContain(
      '<h3 class="studio-heading studio-heading--subsection">Input</h3>',
    );
    expect(markup).toContain("studio-code-block");
  });
});
