import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { StudioPlanNodeSnapshot } from "@seqlane/studio/protocol";
import { Button } from "../../components/ui/button.js";
import {
  StatusBadge,
  statusGlyph,
  statusLabel,
} from "../../components/ui/status-badge.js";
import { Mono, Text } from "../../components/ui/typography.js";
import { formatInvocationContext } from "../invocations/invocation-context.js";
import { invocationNodeMetadata } from "./node-metadata.js";
import type { StudioGraphNode } from "./graph-layout.js";

export { statusGlyph as stateGlyph, statusLabel as stateLabel };

export function sessionLabel(
  session: StudioPlanNodeSnapshot["session"],
): string | undefined {
  if (session === undefined) return undefined;
  return session.type === "isolated"
    ? "isolated"
    : `${session.type} ← ${session.from}`;
}

const StudioPlanNode = memo(function StudioPlanNode({
  data,
}: NodeProps<StudioGraphNode>) {
  if (data.kind !== "plan") return null;
  const {
    invocationContexts,
    invocations,
    onSelectInvocation,
    planNode,
    selectedInvocationId,
  } = data;
  const invocationLabel =
    invocations.length === 0
      ? "Planned"
      : `${invocations.length} invocation${
          invocations.length === 1 ? "" : "s"
        }`;
  const session = sessionLabel(planNode.session);
  return (
    <>
      <Handle
        className="studio-node-handle"
        type="target"
        position={Position.Left}
        isConnectable={false}
        aria-label={`${planNode.label} planned dependencies`}
      />
      <article
        className="studio-node-card"
        aria-label={`${planNode.label}, ${invocationLabel}${
          session === undefined ? "" : `, session ${session}`
        }`}
      >
        <Text as="div" className="studio-node-title" title={planNode.label}>
          {planNode.label}
        </Text>
        <div className="studio-node-topline">
          <Text
            as="span"
            className="studio-node-kind"
            tone="muted"
            variant="meta"
          >
            {planNode.type}
          </Text>
          <Text as="span" className="studio-node-state" variant="meta">
            {invocationLabel}
          </Text>
        </div>
        <div className="studio-node-state-bar" aria-hidden="true" />
        {invocations.length === 0 ? null : (
          <div
            className="studio-node-invocations"
            aria-label={`${invocations.length} task invocations`}
          >
            {invocations.map((invocation, index) => {
              const contextLabel = formatInvocationContext(
                invocationContexts.get(invocation.invocationId),
              );
              const instanceLabel =
                contextLabel ??
                (invocations.length > 1
                  ? `Instance ${index + 1}/${invocations.length}`
                  : "Execution");
              const selected = invocation.invocationId === selectedInvocationId;
              return (
                <Button
                  key={invocation.invocationId}
                  className={
                    selected
                      ? "studio-node-invocation-row selected"
                      : "studio-node-invocation-row"
                  }
                  size="compact"
                  aria-label={`${invocation.label}, ${statusLabel(
                    invocation.state,
                  )}, ${instanceLabel}`}
                  aria-pressed={selected}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelectInvocation?.(invocation.invocationId);
                  }}
                >
                  <span className="studio-node-invocation-copy">
                    <Text as="span" className="studio-node-invocation-label">
                      {invocation.label}
                    </Text>
                    <Text
                      as="span"
                      className="studio-node-invocation-context"
                      tone="muted"
                      variant="meta"
                    >
                      {instanceLabel}
                    </Text>
                  </span>
                  <StatusBadge
                    status={invocation.state}
                    className="studio-node-invocation-status"
                  />
                </Button>
              );
            })}
          </div>
        )}
        <div className="studio-node-chips">
          {session === undefined ? null : (
            <Mono className="studio-node-chip" title={`Session ${session}`}>
              <b>Session</b> {session}
            </Mono>
          )}
          {planNode.maximumIterations === undefined ? null : (
            <Mono className="studio-node-chip">
              <b>Max</b> {planNode.maximumIterations}
            </Mono>
          )}
          <Mono className="studio-node-chip studio-plan-chip">plan node</Mono>
        </div>
        <Mono
          as="div"
          className="studio-node-footer"
          title={planNode.planNodeId}
        >
          {planNode.planNodeId}
        </Mono>
      </article>
      <Handle
        className="studio-node-handle"
        type="source"
        position={Position.Right}
        isConnectable={false}
        aria-label={`${planNode.label} planned dependants`}
      />
    </>
  );
});

const StudioInvocationNode = memo(function StudioInvocationNode({
  data,
}: NodeProps<StudioGraphNode>) {
  if (data.kind !== "invocation") return null;
  const { context, invocation } = data;
  const contextLabel = formatInvocationContext(context);
  const metadata = invocationNodeMetadata(invocation);
  const chips = [
    metadata.duration,
    metadata.tokens,
    metadata.cost,
    metadata.validation,
    metadata.validationEvidence,
  ].filter((value): value is string => value !== undefined);
  const accessibleMetadata = [
    ...chips,
    metadata.inputState === undefined
      ? undefined
      : `input ${metadata.inputState}`,
    metadata.resultState === undefined
      ? undefined
      : `output ${metadata.resultState}`,
  ].filter((value): value is string => value !== undefined);

  return (
    <>
      <Handle
        className="studio-node-handle"
        type="target"
        position={Position.Left}
        isConnectable={false}
        aria-label={`${invocation.label} dependencies`}
      />
      <article
        className="studio-node-card"
        aria-label={`${invocation.label}, ${statusLabel(invocation.state)}${
          contextLabel === undefined ? "" : `. ${contextLabel}`
        }${
          accessibleMetadata.length === 0
            ? ""
            : `. ${accessibleMetadata.join(", ")}`
        }`}
      >
        <Text as="div" className="studio-node-title" title={invocation.label}>
          {invocation.label}
        </Text>
        <div className="studio-node-topline">
          <Text
            as="span"
            className="studio-node-kind"
            tone="muted"
            variant="meta"
          >
            {invocation.kind}
          </Text>
          <StatusBadge
            status={invocation.state}
            className="studio-node-state"
          />
        </div>
        <div className="studio-node-state-bar" aria-hidden="true" />
        {chips.length > 0 || metadata.inputState || metadata.resultState ? (
          <div className="studio-node-chips">
            {chips.map((chip) => (
              <Mono className="studio-node-chip" key={chip}>
                {chip}
              </Mono>
            ))}
            {metadata.inputState === undefined ? null : (
              <Mono className="studio-node-chip studio-node-io">
                <b>In</b> {metadata.inputState}
              </Mono>
            )}
            {metadata.resultState === undefined ? null : (
              <Mono className="studio-node-chip studio-node-io">
                <b>Out</b> {metadata.resultState}
              </Mono>
            )}
            {contextLabel === undefined ? null : (
              <Mono className="studio-node-chip studio-node-context">
                {contextLabel}
              </Mono>
            )}
          </div>
        ) : null}
        <Mono as="div" className="studio-node-footer" title={invocation.taskId}>
          {invocation.taskId}
        </Mono>
      </article>
      <Handle
        className="studio-node-handle"
        type="source"
        position={Position.Right}
        isConnectable={false}
        aria-label={`${invocation.label} dependants`}
      />
    </>
  );
});

export const nodeTypes = {
  "studio-plan": StudioPlanNode,
  "studio-invocation": StudioInvocationNode,
};
