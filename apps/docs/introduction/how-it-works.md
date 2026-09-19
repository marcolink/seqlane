# How it works

<svg viewBox="0 0 760 290" width="100%" role="img" aria-labelledby="adapter-diagram-title adapter-diagram-description">
  <title id="adapter-diagram-title">Seqlane adapter selection</title>
  <desc id="adapter-diagram-description">An actor runs Seqlane, which selects either the OpenCode or Codex adapter.</desc>
  <defs>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto">
      <path d="M0,0 L0,6 L9,3 z" fill="currentColor" />
    </marker>
  </defs>
  <g fill="none" stroke="var(--vp-c-text-2)" stroke-width="2" marker-end="url(#arrow)">
    <path d="M180 145 H285" />
    <path d="M475 145 H530 V80 H575" />
    <path d="M475 145 H530 V210 H575" />
  </g>
  <g stroke-width="2">
    <rect x="40" y="110" width="140" height="70" rx="12" fill="var(--vp-c-bg-soft)" stroke="var(--vp-c-divider)" />
    <rect x="285" y="100" width="190" height="90" rx="14" fill="var(--vp-c-brand-soft)" stroke="var(--vp-c-brand-1)" />
    <rect x="575" y="45" width="145" height="70" rx="12" fill="var(--vp-c-bg-soft)" stroke="var(--vp-c-divider)" />
    <rect x="575" y="175" width="145" height="70" rx="12" fill="var(--vp-c-bg-soft)" stroke="var(--vp-c-divider)" />
  </g>
  <g fill="var(--vp-c-text-1)" font-family="system-ui, sans-serif" text-anchor="middle">
    <text x="110" y="153" font-size="18">Actor</text>
    <text x="380" y="153" font-size="21" font-weight="650">Seqlane</text>
    <text x="647" y="88" font-size="18">OpenCode</text>
    <text x="647" y="218" font-size="18">Codex</text>
  </g>
</svg>

1. Author a workflow as a typed graph of tasks.
2. Bind inputs. Declare dependencies, sessions, workspaces, and models.
3. Start one workflow run.
4. Seqlane validates the Plan before it starts tasks.
5. Seqlane runs deterministic work locally. It sends agent work to the selected adapter.
6. Seqlane validates task outputs and returns the workflow result.

Independent tasks can run in parallel. Session and workspace policy determines
which tasks wait.

Read [Authoring workflows](/authoring-workflows/overview) for the workflow DSL.
Read [Plan](/authoring-workflows/plan) for the detailed execution model.
Read [Adapters](/adapters/overview) to connect an agent runtime.
