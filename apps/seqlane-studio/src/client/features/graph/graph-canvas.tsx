import { memo, useCallback, type RefObject } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import {
  Controls,
  ReactFlow,
  type ReactFlowInstance,
  type NodeChange,
  type XYPosition,
} from "@xyflow/react";
import { IconButton } from "../../components/ui/button.js";
import {
  measurementsFromNodeChanges,
  type GraphNodeMeasurement,
} from "./graph-measurements.js";
import { type StudioGraph, type StudioGraphNode } from "./graph-layout.js";
import { studioGraphViewport } from "./graph-view.js";
import { nodeTypes } from "./studio-nodes.js";

export const GraphCanvas = memo(function GraphCanvas({
  graph,
  graphFullscreen,
  graphShellRef,
  selectedRunId,
  hasSnapshot,
  onFlowInit,
  onRememberNodeMeasurements,
  onSaveNodePositions,
  onSelectInvocation,
  onToggleFullscreen,
}: {
  readonly graph: StudioGraph;
  readonly graphFullscreen: boolean;
  readonly graphShellRef: RefObject<HTMLDivElement | null>;
  readonly selectedRunId: string | undefined;
  readonly hasSnapshot: boolean;
  readonly onFlowInit: (instance: ReactFlowInstance<StudioGraphNode>) => void;
  readonly onRememberNodeMeasurements: (
    runId: string,
    measurements: readonly (readonly [string, GraphNodeMeasurement])[],
  ) => void;
  readonly onSaveNodePositions: (
    runId: string,
    positions: readonly (readonly [string, XYPosition])[],
  ) => void;
  readonly onSelectInvocation: (invocationId: string | undefined) => void;
  readonly onToggleFullscreen: () => void;
}) {
  const handleNodesChange = useCallback(
    (changes: NodeChange<StudioGraphNode>[]) => {
      if (selectedRunId === undefined) return;
      const measurements = measurementsFromNodeChanges(changes);
      if (measurements.length > 0) {
        onRememberNodeMeasurements(selectedRunId, measurements);
      }
      const positionChanges = changes.filter(
        (
          change,
        ): change is typeof change & {
          type: "position";
          position: XYPosition;
        } =>
          change.type === "position" &&
          change.position !== undefined &&
          change.dragging === true,
      );
      onSaveNodePositions(
        selectedRunId,
        positionChanges.map((change) => [change.id, change.position]),
      );
    },
    [onRememberNodeMeasurements, onSaveNodePositions, selectedRunId],
  );

  return (
    <div
      ref={graphShellRef}
      className="graph-shell"
      aria-label="Interactive invocation graph"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        onSelectInvocation(undefined);
        if (document.fullscreenElement === graphShellRef.current) {
          void document.exitFullscreen();
        }
      }}
    >
      <IconButton
        className="graph-fullscreen-toggle"
        aria-label={
          graphFullscreen ? "Exit graph fullscreen" : "Enter graph fullscreen"
        }
        aria-pressed={graphFullscreen}
        onClick={onToggleFullscreen}
      >
        {graphFullscreen ? (
          <Minimize2 aria-hidden="true" />
        ) : (
          <Maximize2 aria-hidden="true" />
        )}
        <span className="sr-only">
          {graphFullscreen ? "Exit graph fullscreen" : "Enter graph fullscreen"}
        </span>
      </IconButton>
      {!hasSnapshot ? (
        <p className="graph-empty">Select a run to view its graph.</p>
      ) : null}
      <ReactFlow<StudioGraphNode>
        onInit={onFlowInit}
        nodes={graph.nodes}
        edges={graph.edges}
        nodeTypes={nodeTypes}
        nodesDraggable
        nodesConnectable={false}
        nodesFocusable
        edgesFocusable={false}
        selectNodesOnDrag={false}
        elementsSelectable
        onNodeClick={(_, node) => {
          if (node.data.kind === "invocation") {
            onSelectInvocation(node.data.invocation.invocationId);
            return;
          }
          const invocation =
            node.data.invocations.find(
              ({ state }) => state === "active" || state === "retrying",
            ) ?? node.data.invocations.at(-1);
          if (invocation !== undefined) {
            onSelectInvocation(invocation.invocationId);
          }
        }}
        onNodeDragStart={(_, node) => {
          if (node.data.kind === "invocation") {
            onSelectInvocation(node.data.invocation.invocationId);
          }
        }}
        onNodesChange={handleNodesChange}
        onNodeDragStop={(_, node) => {
          if (selectedRunId === undefined) return;
          onSaveNodePositions(selectedRunId, [[node.id, node.position]]);
        }}
        onPaneClick={() => onSelectInvocation(undefined)}
        fitView={hasSnapshot && graph.nodes.length > 0}
        fitViewOptions={studioGraphViewport}
        minZoom={studioGraphViewport.minZoom}
        maxZoom={studioGraphViewport.maxZoom}
        aria-label="Interactive invocation graph"
      >
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
});
