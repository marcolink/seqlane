import { type KeyboardEvent, type PointerEvent, useRef, useState } from "react";
import { Tooltip } from "../components/ui/tooltip.js";
import {
  sidebarWidthAfterDrag,
  type SidebarWidthBounds,
  type StudioSidebar,
} from "./sidebar-resizing.js";

const keyboardStep = 16;

export function SidebarResizeHandle({
  bounds,
  onResize,
  sidebar,
  width,
}: {
  readonly bounds: SidebarWidthBounds;
  readonly onResize: (width: number) => void;
  readonly sidebar: StudioSidebar;
  readonly width: number;
}) {
  const [isResizing, setIsResizing] = useState(false);
  const pointerStart = useRef<
    { readonly x: number; readonly width: number } | undefined
  >(undefined);
  const label = `Resize ${sidebar} drawer`;

  const resizeFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const start = pointerStart.current;
    if (start === undefined) return;
    onResize(
      sidebarWidthAfterDrag(
        sidebar,
        start.width,
        event.clientX - start.x,
        bounds,
      ),
    );
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const pointerDelta =
      event.key === "ArrowLeft"
        ? -keyboardStep
        : event.key === "ArrowRight"
          ? keyboardStep
          : undefined;
    if (pointerDelta === undefined) return;
    event.preventDefault();
    onResize(sidebarWidthAfterDrag(sidebar, width, pointerDelta, bounds));
  };

  return (
    <div
      className={`sidebar-resize-handle sidebar-resize-handle--${sidebar}`}
      data-resizing={isResizing || undefined}
    >
      <Tooltip text="Drag or use arrow keys to resize this drawer">
        <div
          aria-label={label}
          aria-orientation="vertical"
          aria-valuemax={bounds.maximum}
          aria-valuemin={bounds.minimum}
          aria-valuenow={width}
          className="sidebar-resize-handle__control"
          onKeyDown={handleKeyDown}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            pointerStart.current = { x: event.clientX, width };
            event.currentTarget.setPointerCapture(event.pointerId);
            setIsResizing(true);
            event.preventDefault();
          }}
          onPointerMove={resizeFromPointer}
          onPointerUp={(event) => {
            pointerStart.current = undefined;
            event.currentTarget.releasePointerCapture(event.pointerId);
            setIsResizing(false);
          }}
          role="separator"
          tabIndex={0}
        />
      </Tooltip>
    </div>
  );
}
