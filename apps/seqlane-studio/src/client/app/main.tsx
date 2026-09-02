import {
  Component,
  StrictMode,
  useEffect,
  useState,
  type CSSProperties,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import { IconButton } from "../components/ui/button.js";
import { Notice } from "../components/ui/notice.js";
import { Panel } from "../components/ui/panel.js";
import { Separator } from "../components/ui/separator.js";
import { Label } from "../components/ui/typography.js";
import { GraphWorkspace } from "../features/graph/graph-workspace.js";
import {
  InvocationInspector,
  UsedSkills,
  UsedTools,
} from "../features/inspector/inspector.js";
import { Timeline } from "../features/inspector/timeline.js";
import { ReplayControls } from "../features/replay/replay-controls.js";
import { RunList } from "../features/runs/run-list.js";
import { useStudioSession } from "../session/use-studio-session.js";
import {
  applyStudioColorScheme,
  type StudioColorScheme,
} from "./color-scheme.js";
import { SidebarResizeHandle } from "./sidebar-resize-handle.js";
import {
  clampSidebarWidth,
  collapsedSidebarWidth,
  minimumSidebarWidths,
  sidebarWidthBounds,
} from "./sidebar-resizing.js";
import { StudioHeader } from "./studio-header.js";
import "@xyflow/react/dist/style.css";
import "./styles.css";

function currentViewportWidth(): number {
  if (typeof document === "undefined") return 1_280;
  return document.documentElement.clientWidth;
}

function StudioApp() {
  const {
    connected,
    error,
    exitReplay,
    graph,
    invocation,
    invocationContext,
    pauseReplay,
    playReplay,
    replay,
    replayControlsVisible,
    resetReplay,
    runs,
    saveNodePositions,
    selectRun,
    selectedInvocationId,
    selectedRunId,
    setReplaySpeed,
    setSelectedInvocationId,
    snapshot,
    stepReplay,
    timeline,
    toolUsage,
    skillUsage,
  } = useStudioSession();
  const [runsDrawerOpen, setRunsDrawerOpen] = useState(true);
  const [inspectorDrawerOpen, setInspectorDrawerOpen] = useState(true);
  const [colorScheme, setColorScheme] = useState<StudioColorScheme>("dark");
  const [runsDrawerWidth, setRunsDrawerWidth] = useState<number>(
    minimumSidebarWidths.runs,
  );
  const [inspectorDrawerWidth, setInspectorDrawerWidth] = useState<number>(
    minimumSidebarWidths.inspector,
  );
  const [viewportWidth, setViewportWidth] = useState(currentViewportWidth);

  const runsBounds = sidebarWidthBounds({
    sidebar: "runs",
    viewportWidth,
    otherSidebarWidth: inspectorDrawerOpen
      ? inspectorDrawerWidth
      : collapsedSidebarWidth,
  });
  const inspectorBounds = sidebarWidthBounds({
    sidebar: "inspector",
    viewportWidth,
    otherSidebarWidth: runsDrawerOpen
      ? runsDrawerWidth
      : collapsedSidebarWidth,
  });
  const layoutStyle = {
    "--inspector-drawer-width": `${inspectorDrawerOpen ? inspectorDrawerWidth : collapsedSidebarWidth}px`,
    "--runs-drawer-width": `${runsDrawerOpen ? runsDrawerWidth : collapsedSidebarWidth}px`,
  } as CSSProperties;

  useEffect(() => {
    applyStudioColorScheme(document.documentElement, colorScheme);
  }, [colorScheme]);

  useEffect(() => {
    const updateViewportWidth = () => setViewportWidth(currentViewportWidth());
    window.addEventListener("resize", updateViewportWidth);
    return () => window.removeEventListener("resize", updateViewportWidth);
  }, []);

  useEffect(() => {
    setRunsDrawerWidth((current) => clampSidebarWidth(current, runsBounds));
    setInspectorDrawerWidth((current) =>
      clampSidebarWidth(current, inspectorBounds),
    );
  }, [inspectorBounds.maximum, runsBounds.maximum]);

  return (
    <main className="studio-shell">
      <StudioHeader
        colorScheme={colorScheme}
        connected={connected}
        onToggleColorScheme={() =>
          setColorScheme((current) => (current === "dark" ? "light" : "dark"))
        }
      />
      {error === undefined ? null : (
        <Notice className="studio-app-error" tone="error" role="alert">
          {error}
        </Notice>
      )}
      <ReplayControls
        replay={replay}
        visible={replayControlsVisible}
        onExit={exitReplay}
        onPause={pauseReplay}
        onPlay={playReplay}
        onReset={resetReplay}
        onSetSpeed={setReplaySpeed}
        onStep={stepReplay}
      />
      <div
        className={`studio-layout${runsDrawerOpen ? "" : " runs-collapsed"}${inspectorDrawerOpen ? "" : " inspector-collapsed"}`}
        style={layoutStyle}
      >
        {runsDrawerOpen ? (
          <RunList
            runs={runs}
            selectedRunId={selectedRunId}
            onSelect={(runId) => void selectRun(runId)}
            onClose={() => setRunsDrawerOpen(false)}
          />
        ) : (
          <aside
            className="drawer-collapsed runs-drawer-collapsed"
            aria-label="Runs drawer collapsed"
          >
            <IconButton
              onClick={() => setRunsDrawerOpen(true)}
              aria-label="Open runs drawer"
            >
              <PanelLeftOpen aria-hidden="true" />
              <span className="sr-only">Runs</span>
            </IconButton>
          </aside>
        )}
        {runsDrawerOpen ? (
          <SidebarResizeHandle
            bounds={runsBounds}
            onResize={(width) =>
              setRunsDrawerWidth(clampSidebarWidth(width, runsBounds))
            }
            sidebar="runs"
            width={runsDrawerWidth}
          />
        ) : null}
        <GraphWorkspace
          graph={graph}
          snapshot={snapshot}
          selectedRunId={selectedRunId}
          selectedInvocationId={selectedInvocationId}
          onSaveNodePositions={saveNodePositions}
          onSelectInvocation={setSelectedInvocationId}
        />
        {inspectorDrawerOpen ? (
          <SidebarResizeHandle
            bounds={inspectorBounds}
            onResize={(width) =>
              setInspectorDrawerWidth(clampSidebarWidth(width, inspectorBounds))
            }
            sidebar="inspector"
            width={inspectorDrawerWidth}
          />
        ) : null}
        {inspectorDrawerOpen ? (
          <Panel
            as="aside"
            className="inspector-panel"
            aria-label="Invocation inspector"
          >
            <div className="drawer-toolbar">
              <Label>Inspector</Label>
              <IconButton
                className="drawer-close"
                onClick={() => setInspectorDrawerOpen(false)}
                aria-label="Close inspector drawer"
              >
                <PanelRightClose aria-hidden="true" />
              </IconButton>
            </div>
            <InvocationInspector
              invocation={invocation}
              context={invocationContext}
            />
            <Separator />
            <UsedTools snapshot={snapshot} toolUsage={toolUsage} />
            <Separator />
            <UsedSkills snapshot={snapshot} skillUsage={skillUsage} />
            <Separator />
            <Timeline items={timeline} snapshot={snapshot} />
          </Panel>
        ) : (
          <aside
            className="drawer-collapsed inspector-drawer-collapsed"
            aria-label="Inspector drawer collapsed"
          >
            <IconButton
              onClick={() => setInspectorDrawerOpen(true)}
              aria-label="Open inspector drawer"
            >
              <PanelRightOpen aria-hidden="true" />
              <span className="sr-only">Inspector</span>
            </IconButton>
          </aside>
        )}
      </div>
    </main>
  );
}

interface StudioErrorBoundaryState {
  readonly error?: Error;
}

class StudioErrorBoundary extends Component<
  { readonly children: ReactNode },
  StudioErrorBoundaryState
> {
  override state: StudioErrorBoundaryState = {};

  static getDerivedStateFromError(error: Error): StudioErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Keep render failures visible without allowing them to take down the app.
  }

  override render(): ReactNode {
    if (this.state.error !== undefined) {
      return (
        <main className="studio-shell">
          <Notice className="studio-app-error" tone="error" role="alert">
            Studio could not render this update. Reconnect or reload to try
            again.
          </Notice>
        </main>
      );
    }
    return this.props.children;
  }
}

const root = document.getElementById("root");
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <StudioErrorBoundary>
        <StudioApp />
      </StudioErrorBoundary>
    </StrictMode>,
  );
}
