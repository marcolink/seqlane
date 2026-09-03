import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { XYPosition } from "@xyflow/react";
import type {
  StudioRunSnapshot,
  StudioStreamEvent,
} from "@seqlane/studio/protocol";
import {
  graphFor,
  hasSameGraphRendering,
  reconcileGraph,
  type StudioGraph,
} from "../features/graph/graph-layout.js";
import {
  advanceReplay,
  createReplaySession,
  pauseReplay,
  playReplay,
  replayControlsVisible,
  resetReplay,
  setReplaySpeed,
  stepReplay,
  type ReplaySpeed,
  type StudioReplaySession,
} from "../features/replay/replay.js";
import {
  applyStreamEvent,
  createBrowserState,
  refreshBrowserState,
  setRunSnapshot,
} from "./projection.js";
import { createStudioTransport, parseStudioStreamEvent } from "./transport.js";
import { invocationContextMap } from "../features/invocations/invocation-context.js";

interface ReplayQuery {
  readonly replayId: string | undefined;
  readonly debugEnabled: boolean;
}

interface Selection {
  readonly runId: string | undefined;
  readonly invocationId: string | undefined;
}

interface GraphSnapshotCache {
  readonly runId: string;
  readonly snapshot: StudioRunSnapshot;
}

const emptyGraph: StudioGraph = { nodes: [], edges: [] };

function readReplayQuery(): ReplayQuery {
  const params = new URLSearchParams(window.location.search);
  const replayId = params.get("replay") || undefined;
  return { replayId, debugEnabled: params.get("debug") === "1" };
}

function removeReplayQuery(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete("replay");
  url.searchParams.delete("debug");
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function resolveLiveRunId(
  selectedRunId: string | undefined,
  runIds: readonly string[],
): string | undefined {
  return selectedRunId !== undefined && runIds.includes(selectedRunId)
    ? selectedRunId
    : runIds[0];
}

export function useStudioSession() {
  const transport = useMemo(() => createStudioTransport(), []);
  const [state, setState] = useState(createBrowserState);
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [selectedInvocationId, setSelectedInvocationId] = useState<string>();
  const [savedPositions, setSavedPositions] = useState<
    ReadonlyMap<string, ReadonlyMap<string, XYPosition>>
  >(new Map());
  const [replaySavedPositions, setReplaySavedPositions] = useState<
    ReadonlyMap<string, ReadonlyMap<string, XYPosition>>
  >(new Map());
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string>();
  const [replayQuery, setReplayQuery] = useState(readReplayQuery);
  const [replay, setReplay] = useState<StudioReplaySession>();
  const [replayError, setReplayError] = useState<string>();
  const [replaySelectedRunId, setReplaySelectedRunId] = useState<string>();
  const liveSelection = useRef<Selection>({
    runId: undefined,
    invocationId: undefined,
  });
  const previousGraph = useRef<StudioGraph | undefined>(undefined);
  const previousGraphSnapshot = useRef<GraphSnapshotCache | undefined>(
    undefined,
  );

  useEffect(() => {
    if (replay === undefined && replayQuery.replayId === undefined) {
      liveSelection.current = {
        runId: selectedRunId,
        invocationId: selectedInvocationId,
      };
    }
  }, [replay, replayQuery.replayId, selectedInvocationId, selectedRunId]);

  useEffect(() => {
    let disposed = false;
    const reportError = (cause: unknown): void => {
      if (!disposed) setError(errorMessage(cause));
    };
    const loadRuns = async (replace = false): Promise<void> => {
      const runs = await transport.loadRuns();
      const firstRunId = runs.runs[0]?.runId;
      let detail: StudioRunSnapshot | undefined;
      if (firstRunId !== undefined) {
        detail = await transport.loadRun(firstRunId);
        if (!disposed) setSelectedRunId((current) => current ?? firstRunId);
      }
      if (!disposed) {
        setState((current) =>
          refreshBrowserState(
            replace ? createBrowserState() : current,
            runs,
            detail,
          ),
        );
      }
    };

    void loadRuns().catch(reportError);
    const source = new EventSource("/api/events");
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (message) => {
      let streamEvent: StudioStreamEvent;
      try {
        streamEvent = parseStudioStreamEvent(message.data);
      } catch (cause) {
        reportError(cause);
        return;
      }
      setState((current) => applyStreamEvent(current, streamEvent));
    };
    source.addEventListener("stream.reset", () => {
      void loadRuns(true).catch(reportError);
    });
    return () => {
      disposed = true;
      source.close();
    };
  }, [transport]);

  useEffect(() => {
    const replayId = replayQuery.replayId;
    if (replayId === undefined) {
      setReplay(undefined);
      setReplayError(undefined);
      setReplaySelectedRunId(undefined);
      return;
    }

    let disposed = false;
    liveSelection.current = {
      runId: selectedRunId,
      invocationId: selectedInvocationId,
    };
    setReplay(undefined);
    setReplayError(undefined);
    setReplaySelectedRunId(undefined);
    setSelectedInvocationId(undefined);
    void transport
      .loadReplay(replayId)
      .then((payload) => {
        if (!disposed) setReplay(createReplaySession(payload));
      })
      .catch((cause: unknown) => {
        if (!disposed) setReplayError(errorMessage(cause));
      });
    return () => {
      disposed = true;
    };
  }, [replayQuery.replayId, transport]);

  useEffect(() => {
    if (replay?.playback !== "playing") return;
    const timeout = window.setTimeout(
      () => {
        setReplay((current) =>
          current === undefined ? current : advanceReplay(current),
        );
      },
      Math.max(50, 250 / replay.speed),
    );
    return () => window.clearTimeout(timeout);
  }, [replay]);

  const selectRun = async (runId: string): Promise<void> => {
    if (replay !== undefined) {
      setReplaySelectedRunId(runId);
      setSelectedInvocationId(undefined);
      return;
    }
    setSelectedRunId(runId);
    setSelectedInvocationId(undefined);
    try {
      const snapshot = await transport.loadRun(runId);
      setState((current) => setRunSnapshot(current, snapshot));
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const exitReplay = (): void => {
    const selection = liveSelection.current;
    removeReplayQuery();
    setReplayQuery(readReplayQuery());
    setReplay(undefined);
    setReplaySelectedRunId(undefined);
    setSelectedRunId(selection.runId ?? [...state.runs.keys()][0]);
    setSelectedInvocationId(selection.invocationId);
  };

  const activeState = replay?.projection ?? state;
  const runs = useMemo(() => [...activeState.runs.values()], [activeState]);
  const activeRunId =
    replay === undefined
      ? resolveLiveRunId(
          selectedRunId,
          runs.map(({ runId }) => runId),
        )
      : (replaySelectedRunId ?? runs[0]?.runId);
  const snapshot =
    activeRunId === undefined
      ? undefined
      : activeState.snapshots.get(activeRunId);
  const invocation = snapshot?.invocations.find(
    ({ invocationId }) => invocationId === selectedInvocationId,
  );
  const invocationContext = useMemo(() => {
    if (snapshot === undefined || invocation === undefined) return undefined;
    return invocationContextMap(snapshot).get(invocation.invocationId);
  }, [invocation, snapshot]);
  const graphSnapshot = useMemo(() => {
    if (snapshot === undefined || activeRunId === undefined) return undefined;
    const previous = previousGraphSnapshot.current;
    return previous?.runId === activeRunId &&
      hasSameGraphRendering(previous.snapshot, snapshot)
      ? previous.snapshot
      : snapshot;
  }, [activeRunId, snapshot]);
  const graphPositions =
    activeRunId === undefined
      ? undefined
      : (replay === undefined ? savedPositions : replaySavedPositions).get(
          activeRunId,
        );
  const graph = useMemo(() => {
    const next =
      graphSnapshot === undefined
        ? emptyGraph
        : graphFor(
            graphSnapshot,
            selectedInvocationId,
            graphPositions,
            setSelectedInvocationId,
          );
    return reconcileGraph(previousGraph.current, next);
  }, [activeRunId, graphPositions, graphSnapshot, selectedInvocationId]);
  useEffect(() => {
    previousGraph.current = graph;
  }, [graph]);
  useEffect(() => {
    previousGraphSnapshot.current =
      activeRunId === undefined || graphSnapshot === undefined
        ? undefined
        : { runId: activeRunId, snapshot: graphSnapshot };
  }, [activeRunId, graphSnapshot]);
  const timeline =
    activeRunId === undefined
      ? []
      : (activeState.timeline.get(activeRunId) ?? []);

  const saveNodePositions = useCallback(
    (
      runId: string,
      positions: readonly (readonly [string, XYPosition])[],
    ): void => {
      if (positions.length === 0) return;
      const setPositions =
        replay === undefined ? setSavedPositions : setReplaySavedPositions;
      setPositions((current) => {
        const next = new Map(current);
        const runPositions = new Map(current.get(runId) ?? []);
        for (const [nodeId, position] of positions) {
          runPositions.set(nodeId, position);
        }
        next.set(runId, runPositions);
        return next;
      });
    },
    [replay],
  );

  function updateReplay(
    update: (current: StudioReplaySession) => StudioReplaySession,
  ): void {
    setReplay((current) => (current === undefined ? current : update(current)));
  }

  return {
    connected,
    error: replayError ?? error,
    graph,
    invocation,
    invocationContext,
    replay,
    replayControlsVisible: replayControlsVisible(
      replayQuery.debugEnabled,
      replay,
    ),
    replayDebugEnabled: replayQuery.debugEnabled,
    exitReplay,
    pauseReplay: () => updateReplay(pauseReplay),
    playReplay: () => updateReplay(playReplay),
    resetReplay: () => updateReplay(resetReplay),
    setReplaySpeed: (speed: ReplaySpeed) =>
      updateReplay((current) => setReplaySpeed(current, speed)),
    stepReplay: () => updateReplay(stepReplay),
    runs,
    saveNodePositions,
    selectRun,
    selectedInvocationId,
    selectedRunId: activeRunId,
    setSelectedInvocationId,
    snapshot,
    timeline,
    toolUsage:
      activeRunId === undefined
        ? undefined
        : activeState.toolUsage.get(activeRunId),
    skillUsage:
      activeRunId === undefined
        ? undefined
        : activeState.skillUsage.get(activeRunId),
  };
}
