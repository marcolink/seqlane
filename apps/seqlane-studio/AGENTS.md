# Seqlane Studio guide

## Scope

- Studio is a local, read-only browser view of Seqlane runs and recordings.
- Do not add workflow-control actions. Do not add cancel, retry, approval, or execution controls.
- Keep live-session state and replay state separate. A visual change must not change either projection.
- Keep the service loopback-only. Do not add browser persistence, a database, or durable run history.

## Ownership boundaries

- Keep shared presentational primitives in `src/client/components/ui`.
- Keep shell state, session wiring, color-scheme state, and drawer state in `src/client/app`.
- Keep graph, replay, invocation, inspector, and run presentation in their feature directories.
- Keep transport and event projection in `src/client/session`. View components do not parse events or own session policy.
- Keep React Flow lifecycle, fullscreen behavior, and graph focus in the graph feature. Do not move these into UI primitives.
- Keep components local to this app. Do not create a shared workspace package for Studio UI.

## Component system

- Compose feature views from existing UI primitives before adding local markup.
- Use `Button` or `IconButton` for every Studio-owned action. Use `Select` for Studio-owned selects.
- Use `StatusBadge` for named execution state. Use `StatusDot` for compact live state.
- Use `Notice` for user-visible error, warning, or information feedback.
- Use `Progress`, `DescriptionList`, `ValueCard`, `CodeBlock`, and `Separator` for their named presentation roles.
- Use `Disclosure` for an expandable bounded content detail; keep raw `<details>` and `<summary>` markup inside that primitive.
- Use `Tooltip` for concise supplemental context on a labelled control; never use it as the only way to expose an action or repeat its visible label. Never use the native `title` tooltip; always use `Tooltip` when contextual help is required.
- A raw native control belongs only inside its primitive. Add a focused primitive when a repeated role has no primitive.
- Keep primitives presentational. They do not fetch data, mutate session state, or know feature-domain rules.
- Keep domain copy, selection rules, and event-derived calculations in the feature that owns them.
- Update `docs/seqlane-studio-component-system.md` when a primitive or its boundary changes.

## Visual system

- Use Geist as a visual reference, not as a component library to clone.
- Keep main panes dense, flat, and separated by one-pixel rules. Do not add pane shadows or rounded pane borders.
- Use rounded corners for controls and bounded content details when they improve affordance.
- Preserve the dark charcoal scheme and the light scheme. Use existing theme tokens and paired dark rules for new colors.
- Keep text contrast high in both themes. Do not use color as the only state indicator.
- Preserve the compact header, the persistent drawer layout, and the narrow replay bar.
- Use native controls and semantic HTML. Do not replace a native control with a custom ARIA widget without a real need.
- Preserve visible labels, accessible names, keyboard behaviour, disabled states, and reduced-motion behaviour.

## Change discipline

- Preserve read-only behavior during visual and component refactors.
- Do not add a dependency for a small Studio primitive. Do not add a second UI system.
- Do not hand-edit `dist/client`. The production build creates this directory.
- Add a colocated component test for each new primitive or changed component behaviour.
- Do not add tests for typography-only changes. Inspect them in the browser with representative data and both color schemes.
- Use tests that prove rendered semantics, labels, state, or accessibility. Do not use large markup snapshots.
- For visual changes, inspect the live Studio with representative recording or replay data in both color schemes.
- Keep the browser console free of errors and warnings.
- Run the scoped Studio test, typecheck, production build, and repository test-mapping check before a commit.
