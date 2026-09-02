import type {
  StudioInvocationState,
  StudioRunState,
} from "@seqlane/studio/protocol";
import {
  Check,
  Clock3,
  Hourglass,
  Minus,
  Play,
  RotateCcw,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";

export type StudioStatus = StudioInvocationState | StudioRunState;

export const statusToneClasses: Record<StudioStatus, string> = {
  queued:
    "border-status-queued-border bg-status-queued-bg text-status-queued-text",
  waiting:
    "border-status-waiting-border bg-status-waiting-bg text-status-waiting-text",
  active:
    "border-status-active-border bg-status-active-bg text-status-active-text",
  retrying:
    "border-status-retrying-border bg-status-retrying-bg text-status-retrying-text",
  succeeded:
    "border-status-succeeded-border bg-status-succeeded-bg text-status-succeeded-text",
  failed:
    "border-status-failed-border bg-status-failed-bg text-status-failed-text",
  skipped:
    "border-status-skipped-border bg-status-skipped-bg text-status-skipped-text",
  cancelled:
    "border-status-cancelled-border bg-status-cancelled-bg text-status-cancelled-text",
};

export function statusGlyph(status: StudioStatus): string {
  switch (status) {
    case "queued":
      return "○";
    case "waiting":
      return "◌";
    case "active":
      return "●";
    case "retrying":
      return "↻";
    case "succeeded":
      return "✓";
    case "failed":
      return "!";
    case "skipped":
      return "—";
    case "cancelled":
      return "×";
  }
}

export function statusLabel(status: StudioStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

const statusIcons: Record<StudioStatus, LucideIcon> = {
  queued: Clock3,
  waiting: Hourglass,
  active: Play,
  retrying: RotateCcw,
  succeeded: Check,
  failed: TriangleAlert,
  skipped: Minus,
  cancelled: X,
};

export function StatusBadge({
  status,
  className,
}: {
  readonly status: StudioStatus;
  readonly className?: string;
}) {
  const Icon = statusIcons[status];
  return (
    <span
      className={[
        "studio-status-badge state inline-flex items-center gap-1 rounded-full border px-2 py-1 transition-[background-color,border-color,color] duration-200",
        statusToneClasses[status],
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label={statusLabel(status)}
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={2} />
      {statusLabel(status)}
    </span>
  );
}
