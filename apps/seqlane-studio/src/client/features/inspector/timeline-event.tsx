import { ChevronDown } from "lucide-react";
import type {
  StudioRunSnapshot,
  StudioStreamEvent,
} from "@seqlane/studio/protocol";
import { DescriptionList } from "../../components/ui/description-list.js";
import { Disclosure } from "../../components/ui/disclosure.js";
import { Label, Mono, Text } from "../../components/ui/typography.js";
import { CodeBlock } from "../../components/ui/value-card.js";
import { timelineAnnotation } from "../../session/projection.js";
import { timelineEventPresentation } from "./timeline-event-presentation.js";

export function TimelineEvent({
  item,
  duration,
  isOpen,
  onToggle,
  snapshot,
}: {
  readonly duration: string;
  readonly isOpen: boolean;
  readonly item: StudioStreamEvent;
  readonly onToggle: (cursor: number, isOpen: boolean) => void;
  readonly snapshot: StudioRunSnapshot | undefined;
}) {
  const annotation = timelineAnnotation(
    item.event,
    snapshot?.invocations ?? [],
  );
  const presentation = timelineEventPresentation(item.event);
  const Icon = presentation.icon;
  const target =
    annotation.invocationId === undefined
      ? annotation.label
      : `${annotation.label} · ${annotation.invocationId.slice(0, 8)}`;

  return (
    <Disclosure
      className="timeline-event"
      open={isOpen}
      onToggle={(event) => onToggle(item.cursor, event.currentTarget.open)}
      summary={
        <span className="timeline-event__summary">
          <Icon
            aria-hidden="true"
            className={`timeline-event__icon timeline-event__icon--${presentation.iconTone}`}
            size={15}
            strokeWidth={1.8}
          />
          <span className="timeline-event__copy">
            <span className="timeline-event__headline">
              <Text as="strong">{presentation.action}</Text>
              <Mono as="span" className="timeline-event__source">
                {target}
              </Mono>
            </span>
            <Text
              as="span"
              className="timeline-event__detail"
              tone="muted"
              variant="meta"
            >
              {presentation.detail}
            </Text>
          </span>
          <Mono as="span" className="timeline-event__meta">
            {duration} · #{item.cursor}
          </Mono>
          <ChevronDown
            aria-hidden="true"
            className="timeline-event__chevron"
            size={14}
          />
        </span>
      }
    >
      <div className="timeline-event__content">
        <DescriptionList items={presentation.details} />
        <div className="timeline-event__payload">
          <Label as="p">Full event payload</Label>
          <CodeBlock>{JSON.stringify(item.event, null, 2)}</CodeBlock>
        </div>
      </div>
    </Disclosure>
  );
}
