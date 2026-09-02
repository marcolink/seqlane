import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { StudioGraph } from "./graph-layout.js";
import { GraphWorkspace } from "./graph-workspace.js";

vi.mock("./graph-canvas.js", () => ({
  GraphCanvas: () => null,
}));

vi.mock("../invocations/invocation-list.js", () => ({
  InvocationList: () => null,
}));

const graph = {
  nodes: [],
  edges: [],
} satisfies StudioGraph;

describe("GraphWorkspace", () => {
  it("keeps Focus active available without an active invocation", () => {
    const markup = renderToStaticMarkup(
      <GraphWorkspace
        graph={graph}
        snapshot={undefined}
        selectedInvocationId={undefined}
        selectedRunId={undefined}
        onSaveNodePositions={vi.fn()}
        onSelectInvocation={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-pressed="false"');
    expect(markup).not.toContain("disabled");
  });
});
