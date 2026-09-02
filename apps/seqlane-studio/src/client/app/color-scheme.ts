export type StudioColorScheme = "dark" | "light";

export function applyStudioColorScheme(
  root: Pick<HTMLElement, "dataset">,
  scheme: StudioColorScheme,
): void {
  root.dataset.theme = scheme;
}
