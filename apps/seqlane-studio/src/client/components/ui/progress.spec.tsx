import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Progress } from "./progress.js";

describe("Progress", () => {
  it("renders an accessible determinate progress bar", () => {
    const markup = renderToStaticMarkup(
      <Progress label="Invocation progress" max={8} value={4} />,
    );

    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-label="Invocation progress"');
    expect(markup).toContain('aria-valuemax="8"');
    expect(markup).toContain('aria-valuenow="4"');
    expect(markup).toContain("width:50%");
  });

  it("keeps ARIA values within the declared range", () => {
    const markup = renderToStaticMarkup(
      <Progress label="Invocation progress" max={4} value={8} />,
    );

    expect(markup).toContain('aria-valuenow="4"');
    expect(markup).toContain("width:100%");
  });
});
