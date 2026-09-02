import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Select } from "./select.js";

describe("Select", () => {
  it("associates a native select with its visible label", () => {
    const markup = renderToStaticMarkup(
      <Select id="replay-speed" label="Speed" value="1" onChange={() => {}}>
        <option value="1">1x</option>
      </Select>,
    );

    expect(markup).toContain("studio-select");
    expect(markup).toContain('for="replay-speed"');
    expect(markup).toContain('<select id="replay-speed"');
  });
});
