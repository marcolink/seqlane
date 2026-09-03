import { useEffect, useState } from "react";
import type {
  StudioRunSnapshot,
  StudioStreamEvent,
} from "@seqlane/studio/protocol";
import { formatEventDuration } from "../../session/projection.js";
import { Heading, Text } from "../../components/ui/typography.js";
import { TimelineEvent } from "./timeline-event.js";

export function updateExpandedTimelineCursor(
  currentCursor: number | undefined,
  cursor: number,
  isOpen: boolean,
): number | undefined {
  if (isOpen) return cursor;
  return currentCursor === cursor ? undefined : currentCursor;
}

export function Timeline({
  items,
  snapshot,
}: {
  readonly items: readonly StudioStreamEvent[];
  readonly snapshot: StudioRunSnapshot | undefined;
}) {
  const [expandedCursor, setExpandedCursor] = useState<number | undefined>();
  const runId = snapshot?.summary.runId;

  useEffect(() => setExpandedCursor(undefined), [runId]);

  return (
    <section className="timeline" aria-labelledby="timeline-heading">
      <div className="panel-heading">
        <Heading id="timeline-heading">Event timeline</Heading>
      </div>
      {items.length === 0 ? (
        <Text as="p" tone="muted" variant="meta">
          No live events received for this run.
        </Text>
      ) : (
        <ol>
          {items.map((item, index) => (
            <li key={item.cursor}>
              <TimelineEvent
                duration={formatEventDuration(items[index - 1], item)}
                isOpen={expandedCursor === item.cursor}
                item={item}
                onToggle={(cursor, isOpen) =>
                  setExpandedCursor((currentCursor) =>
                    updateExpandedTimelineCursor(currentCursor, cursor, isOpen),
                  )
                }
                snapshot={snapshot}
              />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
