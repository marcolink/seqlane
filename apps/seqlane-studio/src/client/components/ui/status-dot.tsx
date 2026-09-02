import type { HTMLAttributes } from "react";
import type { StudioStatus } from "./status-badge.js";

export type StatusDotTone = StudioStatus | "neutral" | "planned" | "positive";

interface StatusDotProps extends HTMLAttributes<HTMLSpanElement> {
  readonly tone: StatusDotTone;
  readonly pulse?: boolean;
}

export function StatusDot({
  className,
  pulse = false,
  tone,
  ...props
}: StatusDotProps) {
  return (
    <span
      {...props}
      aria-hidden="true"
      className={[
        "studio-status-dot",
        `studio-status-dot--${tone}`,
        pulse ? "studio-status-dot--pulse" : undefined,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    />
  );
}
