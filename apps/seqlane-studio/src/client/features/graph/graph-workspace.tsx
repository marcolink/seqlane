import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Focus } from "lucide-react";
import { type ReactFlowInstance, type XYPosition } from "@xyflow/react";
import type { StudioRunSnapshot } from "@seqlane/studio/protocol";
import { Button } from "../../components/ui/button.js";
import { Notice } from "../../components/ui/notice.js";
import { Label, Mono } from "../../components/ui/typography.js";
import { InvocationList } from "../invocations/invocation-list.js";
import { type StudioGraph, type StudioGraphNode } from "./graph-layout.js";
import { GraphCanvas } from "./graph-canvas.js";
import {
  applyGraphMeasurements,
  type GraphNodeMeasurement,
} from "./graph-measurements.js";
import {
  focusInvocationId,
  shouldRefitGraph,
  studioGraphViewport,
  type GraphRunState,
} from "./graph-view.js";

export function GraphWorkspace({
  graph,
  snapshot,
  selectedRunId,
  selectedInvocationId,
  onSaveNodePositions,
  onSelectInvocation,
}: {
  readonly graph: StudioGraph;
  readonly snapshot: StudioRunSnapshot | undefined;
  readonly selectedRunId: string | undefined;
  readonly selectedInvocationId: string | undefined;
  readonly onSaveNodePositions: (
    runId: string,
    positions: readonly (readonly [string, XYPosition])[],
  ) => void;
  readonly onSelectInvocation: (invocationId: string | undefined) => void;
}) {
  const [flowInstance, setFlowInstance] =
    useState<ReactFlowInstance<StudioGraphNode>>();
  const [focusMode, setFocusMode] = useState(false);
  const [graphFullscreen, setGraphFullscreen] = useState(false);
  const [measurementsByRun, setMeasurementsByRun] = useState<
    ReadonlyMap<string, ReadonlyMap<string, GraphNodeMeasurement>>
  >(new Map());
  const graphShellRef = useRef<HTMLDivElement>(null);
  const previousGraphRun = useRef<GraphRunState | undefined>(undefined);
  const measurements =
    selectedRunId === undefined
      ? undefined
      : measurementsByRun.get(selectedRunId);
  const measuredGraph = useMemo(
    () => applyGraphMeasurements(graph, measurements),
    [graph, measurements],
  );
  const focusInvocation = useMemo(
    () =>
      snapshot === undefined
        ? undefined
        : snapshot.invocations.find(
            ({ invocationId }) =>
              invocationId ===
              focusInvocationId(snapshot.invocations, selectedInvocationId),
          ),
    [selectedInvocationId, snapshot],
  );

  useEffect(() => {
    const handleFullscreenChange = () => {
      setGraphFullscreen(document.fullscreenElement === graphShellRef.current);
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () =>
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  useEffect(() => {
    const runId = snapshot?.summary.runId;
    const state = snapshot?.summary.state;
    if (
      runId === undefined ||
      state === undefined ||
      measuredGraph.nodes.length === 0
    ) {
      return;
    }
    const currentGraphRun: GraphRunState = {
      runId,
      state,
    };
    const shouldFit = shouldRefitGraph(
      previousGraphRun.current,
      currentGraphRun,
    );
    previousGraphRun.current = currentGraphRun;
    if (!shouldFit || flowInstance === undefined) return;
    void flowInstance.fitView({
      padding: studioGraphViewport.padding,
      minZoom: studioGraphViewport.initialMinZoom,
      duration: 220,
    });
  }, [
    flowInstance,
    measuredGraph.nodes.length,
    snapshot?.summary.runId,
    snapshot?.summary.state,
  ]);

  useEffect(() => {
    if (
      !focusMode ||
      flowInstance === undefined ||
      focusInvocation === undefined
    ) {
      return;
    }
    const node =
      flowInstance.getNode(`plan:${focusInvocation.planNodeId}`) ??
      flowInstance.getNode(`invocation:${focusInvocation.invocationId}`);
    if (node === undefined) return;
    const width = node.measured?.width ?? node.width ?? 240;
    const height = node.measured?.height ?? node.height ?? 120;
    void flowInstance.setCenter(
      node.position.x + width / 2,
      node.position.y + height / 2,
      {
        duration: 420,
        zoom: Math.max(
          studioGraphViewport.initialMinZoom,
          studioGraphViewport.minZoom,
        ),
      },
    );
  }, [focusInvocation?.invocationId, flowInstance, focusMode]);

  const rememberNodeMeasurements = useCallback(
    (
      runId: string,
      measurements: readonly (readonly [string, GraphNodeMeasurement])[],
    ) => {
      setMeasurementsByRun((current) => {
        const currentMeasurements = current.get(runId);
        let nextMeasurements: Map<string, GraphNodeMeasurement> | undefined;
        for (const [nodeId, measurement] of measurements) {
          const existing = (nextMeasurements ?? currentMeasurements)?.get(
            nodeId,
          );
          if (
            existing?.width === measurement.width &&
            existing.height === measurement.height
          ) {
            continue;
          }
          if (nextMeasurements === undefined) {
            nextMeasurements = new Map(currentMeasurements);
          }
          nextMeasurements.set(nodeId, measurement);
        }
        if (nextMeasurements === undefined) return current;
        const next = new Map(current);
        next.set(runId, nextMeasurements);
        return next;
      });
    },
    [],
  );

  const toggleGraphFullscreen = useCallback(async () => {
    const graphShell = graphShellRef.current;
    if (graphShell === null) return;
    if (document.fullscreenElement === graphShell) {
      await document.exitFullscreen();
      return;
    }
    await graphShell.requestFullscreen();
  }, []);

  const handleToggleGraphFullscreen = useCallback(() => {
    void toggleGraphFullscreen();
  }, [toggleGraphFullscreen]);

  return (
    <section className="workspace-panel" aria-label="Execution workspace">
      <div className="workspace-heading">
        <div>
          <Label as="p" className="eyebrow">
            Graph
          </Label>
          <Mono
            className="workspace-workflow-id"
            title={snapshot?.summary.workflowId}
          >
            {snapshot?.summary.workflowId ?? "Select a run"}
          </Mono>
        </div>
        <div className="workspace-actions">
          <Button
            className={
              focusMode ? "graph-focus-toggle active" : "graph-focus-toggle"
            }
            size="compact"
            aria-pressed={focusMode}
            onClick={() => setFocusMode((current) => !current)}
          >
            <Focus aria-hidden="true" /> Focus active
          </Button>
          {snapshot?.summary.isIncomplete ? (
            <Notice tone="warning">Incomplete event data</Notice>
          ) : null}
        </div>
      </div>
      <GraphCanvas
        graph={measuredGraph}
        graphFullscreen={graphFullscreen}
        graphShellRef={graphShellRef}
        selectedRunId={selectedRunId}
        hasSnapshot={snapshot !== undefined}
        onFlowInit={setFlowInstance}
        onRememberNodeMeasurements={rememberNodeMeasurements}
        onSaveNodePositions={onSaveNodePositions}
        onSelectInvocation={onSelectInvocation}
        onToggleFullscreen={handleToggleGraphFullscreen}
      />
      <InvocationList
        snapshot={snapshot}
        selectedId={selectedInvocationId}
        onSelect={onSelectInvocation}
      />
    </section>
  );
}
