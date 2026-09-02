import type { StudioRunSnapshot } from "@seqlane/studio/protocol";
import { Button } from "../../components/ui/button.js";
import { Panel } from "../../components/ui/panel.js";
import { Progress } from "../../components/ui/progress.js";
import { StatusBadge } from "../../components/ui/status-badge.js";
import { StatusDot } from "../../components/ui/status-dot.js";
import { Heading, Label, Mono, Text } from "../../components/ui/typography.js";
import {
  formatInvocationContext,
  invocationContextMap,
} from "./invocation-context.js";
import { invocationProgress } from "./invocation-progress.js";

function CurrentInvocationList({
  snapshot,
  selectedId,
  onSelect,
}: {
  readonly snapshot: StudioRunSnapshot;
  readonly selectedId: string | undefined;
  readonly onSelect: (id: string) => void;
}) {
  const contexts = invocationContextMap(snapshot);
  const current = invocationProgress(snapshot).current;
  return (
    <section
      className="current-invocations"
      aria-labelledby="current-tasks-heading"
    >
      <div className="current-invocations-heading">
        <Heading as="h3" id="current-tasks-heading" size="subsection">
          Currently running
        </Heading>
        <Mono>{current.length}</Mono>
      </div>
      <ul>
        {current.map((invocation) => {
          const contextLabel = formatInvocationContext(
            contexts.get(invocation.invocationId),
          );
          return (
            <li key={invocation.invocationId}>
              <Button
                className={
                  invocation.invocationId === selectedId
                    ? "invocation-button current selected"
                    : "invocation-button current"
                }
                onClick={() => onSelect(invocation.invocationId)}
              >
                <StatusDot tone="active" pulse />
                <span className="min-w-0">
                  <Text as="span" className="block truncate">
                    {invocation.label}
                  </Text>
                  {contextLabel === undefined ? null : (
                    <Text
                      as="small"
                      className="mt-1 block truncate"
                      tone="muted"
                      variant="meta"
                    >
                      {contextLabel}
                    </Text>
                  )}
                </span>
                <StatusBadge status={invocation.state} />
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function InvocationList({
  snapshot,
  selectedId,
  onSelect,
}: {
  readonly snapshot: StudioRunSnapshot | undefined;
  readonly selectedId: string | undefined;
  readonly onSelect: (id: string) => void;
}) {
  const contexts =
    snapshot === undefined ? undefined : invocationContextMap(snapshot);
  const progress =
    snapshot === undefined ? undefined : invocationProgress(snapshot);
  return (
    <Panel
      className="invocation-list"
      aria-labelledby="invocation-list-heading"
    >
      <Panel.Header className="panel-heading">
        <Heading id="invocation-list-heading">Invocations</Heading>
        {progress === undefined ? null : (
          <Mono>
            {progress.finished}/{progress.total} finished
          </Mono>
        )}
      </Panel.Header>
      <Panel.Body>
        {snapshot === undefined ? (
          <Text as="p" tone="muted" variant="meta">
            No invocation topology received.
          </Text>
        ) : (
          <>
            <div
              className="invocation-progress"
              role="status"
              aria-live="polite"
            >
              <div className="invocation-progress-heading">
                <div>
                  <Label as="p" className="eyebrow">
                    Run progress
                  </Label>
                  <Text as="strong" className="invocation-progress-title">
                    {progress?.total === 0
                      ? "Waiting for invocation events"
                      : `${progress?.finished} of ${progress?.total} finished`}
                  </Text>
                </div>
                <StatusBadge status={snapshot.summary.state} />
              </div>
              <Progress
                label="Invocation progress"
                max={progress?.total ?? 0}
                value={progress?.finished ?? 0}
              />
              <Text
                as="p"
                className="invocation-progress-meta"
                tone="muted"
                variant="meta"
              >
                {progress?.current.length
                  ? `${progress.current.length} task${
                      progress.current.length === 1 ? "" : "s"
                    } running now`
                  : snapshot.summary.state === "active"
                    ? "Waiting for the next task"
                    : "No tasks running"}
              </Text>
            </div>
            {progress?.current.length ? (
              <CurrentInvocationList
                snapshot={snapshot}
                selectedId={selectedId}
                onSelect={onSelect}
              />
            ) : null}
            {snapshot.invocations.length ? (
              <ul>
                {snapshot.invocations.map((invocation) => {
                  const contextLabel =
                    contexts === undefined
                      ? undefined
                      : formatInvocationContext(
                          contexts.get(invocation.invocationId),
                        );
                  return (
                    <li key={invocation.invocationId}>
                      <Button
                        className={
                          invocation.invocationId === selectedId
                            ? "invocation-button selected"
                            : "invocation-button"
                        }
                        onClick={() => onSelect(invocation.invocationId)}
                      >
                        <span className="min-w-0">
                          <Text as="span" className="block truncate">
                            {invocation.label}
                          </Text>
                          {contextLabel === undefined ? null : (
                            <Text
                              as="small"
                              className="mt-1 block truncate"
                              tone="muted"
                              variant="meta"
                            >
                              {contextLabel}
                            </Text>
                          )}
                        </span>
                        <StatusBadge status={invocation.state} />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </>
        )}
      </Panel.Body>
    </Panel>
  );
}
