export type StudioSidebar = "inspector" | "runs";

export interface SidebarWidthBounds {
  readonly maximum: number;
  readonly minimum: number;
}

export const collapsedSidebarWidth = 44;
export const minimumGraphWidth = 576;
export const minimumSidebarWidths = {
  inspector: 352,
  runs: 240,
} as const;

export function sidebarWidthBounds({
  sidebar,
  viewportWidth,
  otherSidebarWidth,
}: {
  readonly otherSidebarWidth: number;
  readonly sidebar: StudioSidebar;
  readonly viewportWidth: number;
}): SidebarWidthBounds {
  const minimum = minimumSidebarWidths[sidebar];
  return {
    minimum,
    maximum: Math.max(
      minimum,
      viewportWidth - otherSidebarWidth - minimumGraphWidth,
    ),
  };
}

export function clampSidebarWidth(
  width: number,
  bounds: SidebarWidthBounds,
): number {
  return Math.min(bounds.maximum, Math.max(bounds.minimum, width));
}

export function sidebarWidthAfterDrag(
  sidebar: StudioSidebar,
  width: number,
  pointerDelta: number,
  bounds: SidebarWidthBounds,
): number {
  const widthDelta = sidebar === "runs" ? pointerDelta : -pointerDelta;
  return clampSidebarWidth(width + widthDelta, bounds);
}
