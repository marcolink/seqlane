import {
  cloneElement,
  type FocusEvent,
  type ReactElement,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

const tooltipDelay = 150;

type TooltipSide = "top" | "bottom";
type TooltipAlign = "start" | "center" | "end";

interface TooltipTriggerProps {
  readonly "aria-describedby"?: string;
}

interface TooltipProps {
  readonly align?: TooltipAlign;
  readonly children: ReactElement<TooltipTriggerProps>;
  readonly side?: TooltipSide;
  readonly text: string;
}

export function Tooltip({
  align = "center",
  children,
  side = "top",
  text,
}: TooltipProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [hasFocus, setHasFocus] = useState(false);
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const tooltipId = useId();
  const describedBy = [children.props["aria-describedby"], tooltipId]
    .filter(Boolean)
    .join(" ");

  const clearOpenTimer = () => {
    if (openTimer.current === undefined) return;
    clearTimeout(openTimer.current);
    openTimer.current = undefined;
  };

  const openTooltip = () => {
    clearOpenTimer();
    openTimer.current = setTimeout(() => setIsOpen(true), tooltipDelay);
  };

  const closeTooltip = () => {
    clearOpenTimer();
    setIsOpen(false);
  };

  const handleBlur = (event: FocusEvent<HTMLSpanElement>) => {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    setHasFocus(false);
    closeTooltip();
  };

  useEffect(() => clearOpenTimer, []);

  return (
    <span
      className="studio-tooltip"
      onBlur={handleBlur}
      onFocus={() => {
        setHasFocus(true);
        openTooltip();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") closeTooltip();
      }}
      onPointerEnter={openTooltip}
      onPointerLeave={() => {
        if (!hasFocus) closeTooltip();
      }}
    >
      {cloneElement(children, { "aria-describedby": describedBy })}
      <span
        aria-hidden={!isOpen}
        className={`studio-tooltip__content studio-tooltip__content--${side} studio-tooltip__content--align-${align}`}
        hidden={!isOpen}
        id={tooltipId}
        role="tooltip"
      >
        {text}
      </span>
    </span>
  );
}
