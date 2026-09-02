import { useState } from "react";
import type { StudioRunSummary } from "@seqlane/studio/protocol";
import { Check, Copy, PanelLeftClose } from "lucide-react";
import { Button, IconButton } from "../../components/ui/button.js";
import { Panel } from "../../components/ui/panel.js";
import { statusLabel } from "../../components/ui/status-badge.js";
import { StatusDot } from "../../components/ui/status-dot.js";
import { Tooltip } from "../../components/ui/tooltip.js";
import { Label, Mono, Text } from "../../components/ui/typography.js";
import { formatRunDuration } from "./run-duration.js";

interface ClipboardWriter {
  writeText(value: string): Promise<void>;
}

export async function writeRunIdToClipboard(
  runId: string,
  clipboard: ClipboardWriter,
): Promise<void> {
  await clipboard.writeText(runId);
}

export function RunList({
  runs,
  selectedRunId,
  onSelect,
  onClose,
}: {
  readonly runs: readonly StudioRunSummary[];
  readonly selectedRunId: string | undefined;
  readonly onSelect: (runId: string) => void;
  readonly onClose: () => void;
}) {
  const [copiedRunId, setCopiedRunId] = useState<string | undefined>();

  const handleCopyRunId = async (runId: string) => {
    try {
      await writeRunIdToClipboard(runId, navigator.clipboard);
      setCopiedRunId(runId);
    } catch {
      setCopiedRunId(undefined);
    }
  };

  return (
    <Panel as="nav" className="run-list" aria-label="Registered runs">
      <Panel.Header className="panel-heading">
        <Label as="p" className="eyebrow">
          Runs
        </Label>
        <div className="drawer-heading-actions">
          <Mono>{runs.length}</Mono>
          <Tooltip
            align="end"
            side="bottom"
            text="Use the full workspace width"
          >
            <IconButton
              className="drawer-close"
              onClick={onClose}
              aria-label="Close runs drawer"
            >
              <PanelLeftClose aria-hidden="true" />
            </IconButton>
          </Tooltip>
        </div>
      </Panel.Header>
      <Panel.Body>
        {runs.length === 0 ? (
          <Text as="p" tone="muted" variant="meta">
            Waiting for a run.
          </Text>
        ) : null}
        <ul>
          {runs.map((run) => {
            const selected = run.runId === selectedRunId;
            const copied = run.runId === copiedRunId;
            const duration = formatRunDuration(run.startedAt, run.finishedAt);
            return (
              <li key={run.runId}>
                <article
                  className={selected ? "run-card selected" : "run-card"}
                >
                  <Button
                    aria-current={selected ? "true" : undefined}
                    className="run-card-select"
                    onClick={() => onSelect(run.runId)}
                    size="compact"
                  >
                    <span className="run-card-state">
                      <StatusDot tone={run.state} />
                      <Text as="span" className="run-card-state-label">
                        {statusLabel(run.state)}
                      </Text>
                    </span>
                    <Label as="span" className="run-card-id-label">
                      Run ID
                    </Label>
                    <Mono as="span" className="run-card-id">
                      {run.runId}
                    </Mono>
                    {duration === undefined ? null : (
                      <span className="run-card-duration">
                        <Label>Duration</Label>
                        <Mono>{duration}</Mono>
                      </span>
                    )}
                    {run.isIncomplete ? (
                      <Text
                        as="span"
                        className="incomplete-label"
                        tone="faint"
                        variant="meta"
                      >
                        incomplete data
                      </Text>
                    ) : null}
                  </Button>
                  <IconButton
                    aria-label={
                      copied
                        ? `Run ID ${run.runId} copied`
                        : `Copy run ID ${run.runId}`
                    }
                    className={copied ? "run-id-copy copied" : "run-id-copy"}
                    onClick={() => void handleCopyRunId(run.runId)}
                    title={copied ? "Run ID copied" : "Copy run ID"}
                  >
                    {copied ? (
                      <Check aria-hidden="true" />
                    ) : (
                      <Copy aria-hidden="true" />
                    )}
                  </IconButton>
                </article>
              </li>
            );
          })}
        </ul>
      </Panel.Body>
    </Panel>
  );
}
