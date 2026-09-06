import { Command, Flags } from "@oclif/core";
import {
  workflowListResultSchema,
  type WorkflowListRecord,
} from "../cli-contracts.js";
import {
  discoverWorkflowDescriptors,
  listWorkflowRecord,
} from "../workflow-discovery.js";
import { escapeTerminalText } from "../human-output.js";
import { workflowRootsFromFlags } from "../workflow-roots.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function renderWorkflowListHuman(
  records: readonly WorkflowListRecord[],
): string {
  if (records.length === 0) return "No workflows found.";
  return records
    .map(
      ({ qualifiedName, description, moduleSpecifier, exportName }) =>
        `${escapeTerminalText(qualifiedName)}  ${escapeTerminalText(description)}  (${escapeTerminalText(moduleSpecifier)}#${escapeTerminalText(exportName)})`,
    )
    .join("\n");
}

export default class ListCommand extends Command {
  static override description =
    "List repository- and user-scoped workflow descriptors";

  static override flags = {
    output: Flags.string({
      description: "List output mode",
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
    const { flags } = await this.parse(ListCommand);
    try {
      const records = discoverWorkflowDescriptors(
        workflowRootsFromFlags(flags),
      ).map(listWorkflowRecord);
      if (flags.output === "json") {
        this.log(
          JSON.stringify(workflowListResultSchema.parse(records), null, 2),
        );
        return;
      }
      this.log(renderWorkflowListHuman(records));
    } catch (error) {
      this.error(errorMessage(error));
    }
  }
}
