# Seqlane Studio component system

## Objective

Make Studio layout and controls composable without changing the existing visual
language, interaction behavior, or local-only runtime model.

## Commands

```sh
pnpm --filter @seqlane/studio-app build
pnpm exec nx run seqlane-studio:test
pnpm run test:mapping
```

## Project structure

- `apps/seqlane-studio/src/client/components/ui` holds shared primitives.
- `apps/seqlane-studio/src/client/app` composes the Studio shell.
- `apps/seqlane-studio/src/client/features` owns domain-specific presentation
  and interaction.

## Code style

Keep UI primitives small and compose them at the feature boundary:

```tsx
<Button appearance="primary" onClick={onPlay}>Play</Button>
<Heading>Invocations</Heading>
<Text tone="muted" variant="meta">No invocation topology received.</Text>
```

## Boundaries

- Keep components local to `apps/seqlane-studio`.
- Add no dependency and no shared workspace package.
- Keep session state, graph lifecycle, and keyboard behavior in the app layer.
- Preserve existing labels, ARIA semantics, disabled states, and CSS tokens.

## Components

`components/ui` contains small presentational primitives:

- `Button` for labelled actions with `primary` and `quiet` appearances.
- `IconButton` for icon-only actions with a required accessible label.
- `StatusBadge` for a named invocation or run state.
- `StatusDot` for compact live or active state indicators.
- `Notice` for error, warning, and informational feedback.
- `Progress` for labelled, determinate progress.
- `DescriptionList` for compact metadata.
- `ValueCard` for bounded supplemental content.
- `CodeBlock` for bounded structured values and output.
- `Select` for labelled native selections.
- `Separator` for pane-section boundaries.
- `Tooltip` for concise supplemental context on a labelled control.
- `Disclosure` for a collapsed-by-default, semantic expandable content detail.
- `Panel` for semantic application panes.
- `Heading`, `Text`, `Label`, and `Mono` for the shared Studio type scale.

Studio-specific composition stays outside the primitive layer:

- The app header owns colour-scheme state and connection display.
- Drawer controls own their open/close callbacks.
- The workspace owns graph, fullscreen, and focus interactions.
- The invocation Inspector owns its flat, rule-separated sections; it composes
  metadata, state, and `CodeBlock` values without nested cards.
- Feature views compose these primitives; native buttons, selects, progress
  markup, and bounded-value presentation remain inside `components/ui`.

## Verification

- Component tests cover rendered button semantics and variants.
- Typography-only changes use browser inspection with representative data in
  light and dark schemes; they do not require dedicated tests.
- Existing Studio tests retain graph, replay, and session behavior coverage.
- The production build succeeds and the Vite preview has no new runtime errors.

## Success criteria

- App orchestration does not render header or graph implementation details.
- Labelled and icon-only actions use the local button primitives.
- Tooltips supplement a control's accessible name; they do not replace it.
- Existing Studio interactions and visual styles remain unchanged.
