import { Args, Command, Flags } from "@oclif/core";
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
import { escapeTerminalText } from "../human-output.js";
import { isExplicitWorkflowReference } from "../workflow-reference.js";
import { workflowRootsFromFlags } from "../workflow-roots.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  roots: Parameters<typeof discoverWorkflowDescriptors>[0],
): Promise<PlanCommandResult> {
  const selection = resolveWorkflowSelection(
    workflowValue,
    isExplicitWorkflowReference(workflowValue)
      ? []
      : discoverWorkflowDescriptors(roots),
  );
  const loaded = await loadWorkflow(selection.reference);
  return planCommandResultSchema.parse({
    workflow: planWorkflowRecord(selection.descriptor, selection.reference),
    plan: createSeqlanePlanSnapshot(loaded.plan),
  });
}

export function renderPlanHuman(result: PlanCommandResult): string {
  const lines = [
    `Plan for ${escapeTerminalText(result.workflow.qualifiedName)}`,
    `Description: ${escapeTerminalText(result.workflow.description ?? "Direct workflow reference")}`,
    `Module: ${escapeTerminalText(result.workflow.moduleSpecifier)}#${escapeTerminalText(result.workflow.exportName)}`,
    "Nodes:",
  ];
  for (const node of result.plan.nodes) {
    const indent = node.parentPlanNodeId === undefined ? "  " : "    ";
    const execution = "execution" in node ? ` [${node.execution}]` : "";
    const dependencies =
      node.dependsOn.length === 0
        ? ""
        : ` <- ${node.dependsOn.map(escapeTerminalText).join(", ")}`;
    lines.push(
      `${indent}${escapeTerminalText(node.planNodeId)}: ${escapeTerminalText(node.label)}${execution}${dependencies}`,
    );
  }
  return lines.join("\n");
}

export default class PlanCommand extends Command {
  static override description =
    "Compile a workflow Plan without executing tasks or starting a runtime";

  static override examples = [
    '<%= config.bin %> plan repository:review --input \'{"topic":"Seqlane"}\'',
    "<%= config.bin %> plan ./workflows/minimal-example/workflow.ts --output json",
  ];

  static override args = {
    workflow: Args.string({
      description: "qualified workflow name or direct file/module reference",
      required: true,
    }),
  };

  static override flags = {
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
