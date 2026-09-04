import { Args, Command, Flags } from "@oclif/core";
import { isJsonValue, type JsonValue } from "@seqlane/core";
import {
  planCommandResultSchema,
  type PlanCommandResult,
} from "../cli-contracts.js";
import {
  createSeqlanePlanSnapshot,
  loadWorkflow,
} from "@seqlane/runtime/workflow";
import {
  listWorkflowRecord,
  resolveWorkflowSelection,
  type DiscoveredWorkflow,
} from "../workflow-discovery.js";
import { discoverWorkflowDescriptors } from "../workflow-discovery.js";
import { isDirectWorkflowReference } from "../workflow-reference.js";
import { workflowRootsFromFlags } from "./list.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseJsonInput(value: string): JsonValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("--input must be valid JSON");
  }
  if (!isJsonValue(parsed)) throw new Error("--input must be a JSON value");
  return parsed;
}

function planWorkflowRecord(
  descriptor: DiscoveredWorkflow | undefined,
  reference: {
    readonly id: string;
    readonly moduleSpecifier: string;
    readonly exportName: string;
  },
): PlanCommandResult["workflow"] {
  if (descriptor !== undefined) {
    const record = listWorkflowRecord(descriptor);
    return record;
  }
  return {
    name: reference.id,
    scope: "direct",
    qualifiedName: reference.id,
    moduleSpecifier: reference.moduleSpecifier,
    exportName: reference.exportName,
  };
}

export async function createPlanCommandResult(
  workflowValue: string,
  input: JsonValue,
  roots: Parameters<typeof discoverWorkflowDescriptors>[0],
): Promise<PlanCommandResult> {
  const selection = isDirectWorkflowReference(workflowValue)
    ? resolveWorkflowSelection(workflowValue)
    : resolveWorkflowSelection(
        workflowValue,
        discoverWorkflowDescriptors(roots),
      );
  const loaded = await loadWorkflow(selection.reference, input);
  return planCommandResultSchema.parse({
    workflow: planWorkflowRecord(selection.descriptor, selection.reference),
    plan: createSeqlanePlanSnapshot(loaded.plan),
  });
}

export function renderPlanHuman(result: PlanCommandResult): string {
  const lines = [
    `Plan for ${result.workflow.qualifiedName}`,
    `Description: ${result.workflow.description ?? "Direct workflow reference"}`,
    `Module: ${result.workflow.moduleSpecifier}#${result.workflow.exportName}`,
    "Nodes:",
  ];
  for (const node of result.plan.nodes) {
    const indent = node.parentPlanNodeId === undefined ? "  " : "    ";
    const execution = "execution" in node ? ` [${node.execution}]` : "";
    const dependencies =
      node.dependsOn.length === 0 ? "" : ` <- ${node.dependsOn.join(", ")}`;
    lines.push(
      `${indent}${node.planNodeId}: ${node.label}${execution}${dependencies}`,
    );
  }
  return lines.join("\n");
}

export default class PlanCommand extends Command {
  static override description =
    "Compile a workflow Plan without executing tasks or starting a runtime";

  static override examples = [
    '<%= config.bin %> plan repository:review --input \'{"topic":"Seqlane"}\'',
    "<%= config.bin %> plan ./examples/minimal-workflow.ts --output json",
  ];

  static override args = {
    workflow: Args.string({
      description: "qualified workflow name or direct file/module reference",
      required: true,
    }),
  };

  static override flags = {
    input: Flags.string({
      char: "i",
      description: "JSON workflow input for Plan factories",
      default: "null",
    }),
    output: Flags.string({
      description: "Plan output mode",
      options: ["human", "json"],
      default: "human",
    }),
    "repository-root": Flags.string({
      description: "Repository workflow descriptor root",
    }),
    "user-root": Flags.string({
      description: "User workflow descriptor root",
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(PlanCommand);
    try {
      const result = await createPlanCommandResult(
        args.workflow,
        parseJsonInput(flags.input),
        workflowRootsFromFlags(flags),
      );
      this.log(
        flags.output === "json"
          ? JSON.stringify(result, null, 2)
          : renderPlanHuman(result),
      );
    } catch (error) {
      this.error(errorMessage(error));
    }
  }
}
