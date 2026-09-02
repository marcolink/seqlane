import type {
  StudioInvocationActivity,
  StudioInvocationSnapshot,
  StudioRunSnapshot,
} from "@seqlane/studio/protocol";
import { DescriptionList } from "../../components/ui/description-list.js";
import { Notice } from "../../components/ui/notice.js";
import { StatusBadge } from "../../components/ui/status-badge.js";
import { Heading, Label, Mono, Text } from "../../components/ui/typography.js";
import { CodeBlock } from "../../components/ui/value-card.js";
import {
  formatInvocationContext,
  type InvocationDisplayContext,
} from "../invocations/invocation-context.js";
import {
  InspectorSection,
  InspectorValueSection,
  InspectorValueSubsection,
} from "./inspector-section.js";

interface UsedTool {
  readonly name: string;
  readonly count: number;
  readonly latest?: StudioInvocationActivity;
}

function usedTools(
  snapshot: StudioRunSnapshot | undefined,
  toolUsage: ReadonlyMap<string, number> | undefined,
  kind: StudioInvocationActivity["kind"],
): readonly UsedTool[] {
  if (snapshot === undefined) return [];
  const usage =
    toolUsage ??
    new Map(
      (kind === "skill" ? snapshot.skillUsage : snapshot.toolUsage)?.map(
        ({ name, count }) => [name, count] as const,
      ),
    );
  const tools = new Map<string, UsedTool>();
  for (const [name, count] of usage) tools.set(name, { name, count });
  for (const invocation of snapshot.invocations) {
    for (const activity of invocation.activities ?? []) {
      if (activity.kind !== kind) continue;
      const current = tools.get(activity.name);
      const isLater =
        current === undefined ||
        current.latest === undefined ||
        Date.parse(activity.occurredAt) >=
          Date.parse(current.latest.occurredAt);
      tools.set(activity.name, {
        name: activity.name,
        count: current?.count ?? 1,
        latest: isLater ? activity : current.latest,
      });
    }
  }
  return [...tools.values()];
}

export function UsedTools({
  snapshot,
  toolUsage,
}: {
  readonly snapshot: StudioRunSnapshot | undefined;
  readonly toolUsage?: ReadonlyMap<string, number>;
}) {
  const tools = usedTools(snapshot, toolUsage, "tool");
  return (
    <UsedActivityList
      heading="Used tools"
      emptyLabel="No tool activity received."
      tools={tools}
    />
  );
}

export function UsedSkills({
  snapshot,
  skillUsage,
}: {
  readonly snapshot: StudioRunSnapshot | undefined;
  readonly skillUsage?: ReadonlyMap<string, number>;
}) {
  const skills = usedTools(snapshot, skillUsage, "skill");
  return (
    <UsedActivityList
      heading="Used skills"
      emptyLabel="No skill activity received."
      tools={skills}
    />
  );
}

function UsedActivityList({
  heading,
  emptyLabel,
  tools,
}: {
  readonly heading: string;
  readonly emptyLabel: string;
  readonly tools: readonly UsedTool[];
}) {
  return (
    <section className="used-tools" aria-label={heading}>
      <div className="panel-heading">
        <Heading>{heading}</Heading>
        <Mono>{tools.length}</Mono>
      </div>
      {tools.length === 0 ? (
        <Text as="p" tone="muted" variant="meta">
          {emptyLabel}
        </Text>
      ) : (
        <ul className="tool-list">
          {tools.map((tool) => (
            <li key={tool.name}>
              <div className="tool-list-heading">
                <Text as="strong">{tool.name}</Text>
                <Text as="span" tone="muted" variant="meta">
                  {tool.latest?.state ?? "received"}
                </Text>
              </div>
              <Text as="small" tone="muted" variant="meta">
                {tool.count} use{tool.count === 1 ? "" : "s"}
              </Text>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function InvocationInspector({
  invocation,
  context,
}: {
  readonly invocation: StudioInvocationSnapshot | undefined;
  readonly context?: InvocationDisplayContext;
}) {
  if (invocation === undefined) {
    return (
      <Text as="p" tone="muted" variant="meta">
        Select an invocation to inspect it.
      </Text>
    );
  }
  return (
    <div className="inspector-content">
      <div className="inspector-title">
        <div>
          <Label as="p" className="eyebrow">
            Invocation
          </Label>
          <Heading size="title">{invocation.label}</Heading>
        </div>
        <StatusBadge status={invocation.state} />
      </div>
      {formatInvocationContext(context) === undefined ? null : (
        <Text as="p" className="mb-4" tone="muted" variant="meta">
          {formatInvocationContext(context)}
        </Text>
      )}
      <DescriptionList
        items={[
          {
            term: "Invocation",
            description: <Mono>{invocation.invocationId}</Mono>,
          },
          {
            term: "Plan node",
            description: <Mono>{invocation.planNodeId}</Mono>,
          },
          { term: "Task", description: <Mono>{invocation.taskId}</Mono> },
        ]}
      />
      <InspectorValueSection value={invocation.input} heading="Input" />
      <InspectorValueSection value={invocation.result} heading="Result" />
      {invocation.validation === undefined ? null : (
        <InspectorSection
          detail={invocation.validation.verdict}
          heading="Validation"
        >
          <DescriptionList
            className="validation-metadata-list"
            items={[
              {
                term: "Source",
                description: <Mono>{invocation.validation.sourceId}</Mono>,
              },
              {
                term: "Validation node",
                description: (
                  <Mono>{invocation.validation.validationNodeId}</Mono>
                ),
              },
              { term: "Verdict", description: invocation.validation.verdict },
              ...(invocation.validation.continued
                ? [
                    {
                      term: "Repeat",
                      description: "continues after failed postcondition",
                    },
                  ]
                : []),
            ]}
          />
          {invocation.validation.issues.length === 0 ? (
            <Text as="p" tone="muted" variant="meta">
              No validation issues.
            </Text>
          ) : (
            <ul className="validation-issues">
              {invocation.validation.issues.map((issue, index) => (
                <li key={`${issue.code}-${index}`}>
                  <Mono as="strong">{issue.code}</Mono>: {issue.message}
                  {issue.path === undefined ? "" : ` (${issue.path})`}
                </li>
              ))}
            </ul>
          )}
          <InspectorValueSubsection
            value={invocation.validation.evidence}
            heading="Evidence"
          />
        </InspectorSection>
      )}
      <InspectorSection heading="Execution output">
        {invocation.output.transient === undefined ? null : (
          <CodeBlock>{invocation.output.transient}</CodeBlock>
        )}
        {invocation.output.persistent.length === 0 ? (
          <Text as="p" tone="muted" variant="meta">
            No persistent output.
          </Text>
        ) : (
          invocation.output.persistent.map((output, index) => (
            <CodeBlock key={`${index}-${output}`}>{output}</CodeBlock>
          ))
        )}
      </InspectorSection>
      {invocation.error === undefined ? null : (
        <Notice
          className="inspector-error"
          tone="error"
          aria-labelledby="error-heading"
        >
          <Heading as="h3" id="error-heading" size="subsection">
            Error
          </Heading>
          <Text as="p">{invocation.error.message}</Text>
        </Notice>
      )}
    </div>
  );
}
