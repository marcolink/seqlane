import {
  Activity,
  ArrowUpFromLine,
  CircleCheck,
  CircleStop,
  CircleX,
  Clock3,
  FileOutput,
  FileText,
  PackageOpen,
  Play,
  RotateCcw,
  SkipForward,
  Wrench,
} from "lucide-react";
import type { StudioStreamEvent } from "@seqlane/studio/protocol";

type TimelineEvent = StudioStreamEvent["event"];

export interface TimelineDetail {
  readonly description: string;
  readonly term: string;
}

type IconTone = "neutral" | "progress" | "success" | "failure" | "warning";

interface TimelineEventPresentation {
  readonly action: string;
  readonly detail: string;
  readonly details: readonly TimelineDetail[];
  readonly icon: typeof Play;
  readonly iconTone: IconTone;
}

function eventDetails(event: TimelineEvent): readonly TimelineDetail[] {
  return [
    { term: "Event", description: event.type },
    { term: "Run", description: event.runId },
    { term: "Work", description: event.workId },
    { term: "Sequence", description: String(event.metadata.sequence) },
    { term: "Occurred", description: event.metadata.occurredAt },
  ];
}

function invocationDetails(
  event: Extract<TimelineEvent, { readonly invocationId: string }>,
): readonly TimelineDetail[] {
  return [
    ...eventDetails(event),
    { term: "Invocation", description: event.invocationId },
    ...(event.iteration === undefined
      ? []
      : [{ term: "Iteration", description: String(event.iteration) }]),
  ];
}

function valueSummary(value: { readonly state: string }): string {
  switch (value.state) {
    case "present":
      return "Present";
    case "redacted":
      return "Redacted";
    case "truncated":
      return "Truncated";
    case "omitted":
      return "Omitted";
    default:
      return "Unavailable";
  }
}

function compactText(value: string, maximum = 88): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maximum) return normalized || "No text";
  return `${normalized.slice(0, maximum - 1)}…`;
}

function jsonSummary(value: unknown): string {
  return compactText(JSON.stringify(value));
}

function durationLabel(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)} s`;
  return `${(durationMs / 60_000).toFixed(1)} min`;
}

function presentation(
  action: string,
  detail: string,
  icon: typeof Play,
  iconTone: IconTone,
  details: readonly TimelineDetail[],
): TimelineEventPresentation {
  return { action, detail, details, icon, iconTone };
}

export function timelineEventPresentation(
  event: TimelineEvent,
): TimelineEventPresentation {
  switch (event.type) {
    case "run.started":
      return presentation(
        "Run started",
        `Work ${event.workId}`,
        Play,
        "progress",
        eventDetails(event),
      );
    case "run.plan":
      return presentation(
        "Plan received",
        `${event.plan.nodes.length} node${event.plan.nodes.length === 1 ? "" : "s"} · ${event.plan.workflow.id}`,
        FileText,
        "neutral",
        [
          ...eventDetails(event),
          { term: "Workflow", description: event.plan.workflow.id },
          { term: "Plan nodes", description: String(event.plan.nodes.length) },
        ],
      );
    case "run.heartbeat":
      return presentation(
        "Run heartbeat",
        `${event.activeInvocationIds.length} active · ${durationLabel(event.elapsedMs)} elapsed`,
        Activity,
        "progress",
        [
          ...eventDetails(event),
          {
            term: "Active invocations",
            description: event.activeInvocationIds.join(", ") || "None",
          },
          { term: "Elapsed", description: durationLabel(event.elapsedMs) },
        ],
      );
    case "run.succeeded":
      return presentation(
        "Run succeeded",
        `Output ${jsonSummary(event.output)}`,
        CircleCheck,
        "success",
        [
          ...eventDetails(event),
          { term: "Output", description: jsonSummary(event.output) },
        ],
      );
    case "run.failed":
      return presentation(
        "Run failed",
        compactText(event.error.message),
        CircleX,
        "failure",
        [
          ...eventDetails(event),
          { term: "Error category", description: event.error.category },
          { term: "Error", description: event.error.message },
        ],
      );
    case "run.cancelled":
      return presentation(
        "Run cancelled",
        "Execution stopped before completion",
        CircleStop,
        "warning",
        eventDetails(event),
      );
    case "invocation.created":
      return presentation(
        "Invocation created",
        `${event.kind} · ${event.label}`,
        PackageOpen,
        "neutral",
        [
          ...invocationDetails(event),
          { term: "Plan node", description: event.planNodeId },
          { term: "Kind", description: event.kind },
          { term: "Label", description: event.label },
          {
            term: "Dependencies",
            description: event.dependencyIds.join(", ") || "None",
          },
        ],
      );
    case "invocation.progress":
      return presentation(
        event.state === "waiting"
          ? "Invocation waiting"
          : "Invocation progress",
        compactText(event.message ?? event.waitingReason ?? event.phase),
        event.state === "waiting" ? Clock3 : Activity,
        "progress",
        [
          ...invocationDetails(event),
          { term: "State", description: event.state },
          { term: "Phase", description: event.phase },
          ...(event.message === undefined
            ? []
            : [{ term: "Message", description: event.message }]),
          ...(event.waitingReason === undefined
            ? []
            : [{ term: "Waiting reason", description: event.waitingReason }]),
        ],
      );
    case "invocation.output":
      return presentation(
        "Output received",
        compactText(event.content),
        ArrowUpFromLine,
        "neutral",
        [
          ...invocationDetails(event),
          { term: "Policy", description: event.policy },
          { term: "Channel", description: event.channel },
          { term: "Content", description: event.content || "No text" },
          ...(event.metrics === undefined
            ? []
            : [{ term: "Metrics", description: jsonSummary(event.metrics) }]),
        ],
      );
    case "invocation.activity":
      return presentation(
        `${event.kind === "tool" ? "Tool" : "Skill"} ${event.state}`,
        event.name,
        Wrench,
        event.state === "failed" ? "failure" : "progress",
        [
          ...invocationDetails(event),
          { term: "Activity", description: event.name },
          { term: "Kind", description: event.kind },
          { term: "State", description: event.state },
          ...(event.message === undefined
            ? []
            : [{ term: "Message", description: event.message }]),
        ],
      );
    case "invocation.input":
      return presentation(
        "Input received",
        valueSummary(event.input),
        FileText,
        "neutral",
        [
          ...invocationDetails(event),
          { term: "Input", description: valueSummary(event.input) },
        ],
      );
    case "invocation.result":
      return presentation(
        "Result received",
        valueSummary(event.result),
        FileOutput,
        "neutral",
        [
          ...invocationDetails(event),
          { term: "Result", description: valueSummary(event.result) },
        ],
      );
    case "invocation.retrying":
      return presentation(
        "Retry scheduled",
        `Attempt ${event.attempt}${event.maximumAttempts === undefined ? "" : ` of ${event.maximumAttempts}`} · ${compactText(event.lastError.message)}`,
        RotateCcw,
        "warning",
        [
          ...invocationDetails(event),
          { term: "Attempt", description: String(event.attempt) },
          ...(event.maximumAttempts === undefined
            ? []
            : [
                {
                  term: "Maximum attempts",
                  description: String(event.maximumAttempts),
                },
              ]),
          ...(event.delayMs === undefined
            ? []
            : [
                {
                  term: "Retry delay",
                  description: durationLabel(event.delayMs),
                },
              ]),
          { term: "Last error", description: event.lastError.message },
        ],
      );
    case "invocation.started":
      return presentation(
        "Invocation started",
        event.subject.type,
        Play,
        "progress",
        [
          ...invocationDetails(event),
          { term: "Subject", description: jsonSummary(event.subject) },
          ...(event.taskId === undefined
            ? []
            : [{ term: "Task", description: event.taskId }]),
        ],
      );
    case "invocation.succeeded":
      return presentation(
        "Invocation succeeded",
        "Completed successfully",
        CircleCheck,
        "success",
        invocationDetails(event),
      );
    case "invocation.failed":
      return presentation(
        "Invocation failed",
        compactText(event.error.message),
        CircleX,
        "failure",
        [
          ...invocationDetails(event),
          { term: "Disposition", description: event.disposition },
          { term: "Error category", description: event.error.category },
          { term: "Error", description: event.error.message },
        ],
      );
    case "invocation.skipped":
      return presentation(
        "Invocation skipped",
        compactText(event.reason),
        SkipForward,
        "warning",
        [
          ...invocationDetails(event),
          { term: "Reason", description: event.reason },
          ...(event.dependencyIds === undefined
            ? []
            : [
                {
                  term: "Dependencies",
                  description: event.dependencyIds.join(", ") || "None",
                },
              ]),
        ],
      );
    case "invocation.cancelled":
      return presentation(
        "Invocation cancelled",
        event.reason === undefined
          ? "Cancelled by execution policy"
          : compactText(event.reason),
        CircleStop,
        "warning",
        [
          ...invocationDetails(event),
          ...(event.reason === undefined
            ? []
            : [{ term: "Reason", description: event.reason }]),
        ],
      );
  }
}
