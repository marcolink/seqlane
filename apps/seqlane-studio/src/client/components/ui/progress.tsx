import type { HTMLAttributes } from "react";

interface ProgressProps extends HTMLAttributes<HTMLDivElement> {
  readonly label: string;
  readonly max: number;
  readonly value: number;
}

export function Progress({
  className,
  label,
  max,
  value,
  ...props
}: ProgressProps) {
  const maximum = Math.max(0, max);
  const current = Math.min(Math.max(0, value), maximum);
  const percent = maximum === 0 ? 0 : (current / maximum) * 100;

  return (
    <div
      {...props}
      aria-label={label}
      aria-valuemax={maximum}
      aria-valuemin={0}
      aria-valuenow={current}
      className={["studio-progress", className].filter(Boolean).join(" ")}
      role="progressbar"
    >
      <span style={{ width: `${percent}%` }} />
    </div>
  );
}
