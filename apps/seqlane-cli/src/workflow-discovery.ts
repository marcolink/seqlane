import type { WorkflowDescriptor, WorkflowReference } from "@seqlane/core";
import { workflowDescriptorSchema } from "@seqlane/core";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  parseWorkflowReference,
  isExplicitWorkflowReference,
  isDirectWorkflowReference,
} from "./workflow-reference.js";

export type WorkflowScope = "repository" | "user";

export interface WorkflowRoots {
  readonly repository: string;
  readonly user: string;
}

export interface DiscoveredWorkflow {
  readonly descriptor: WorkflowDescriptor;
  readonly descriptorPath: string;
  readonly scope: WorkflowScope;
  readonly qualifiedName: string;
  readonly reference: WorkflowReference;
}

export interface WorkflowSelection {
  readonly reference: WorkflowReference;
  readonly descriptor?: DiscoveredWorkflow;
}

export function defaultWorkflowRoots(
  cwd: string = process.cwd(),
  userHome: string = homedir(),
): WorkflowRoots {
  return {
    repository: resolve(cwd, ".seqlane", "workflows"),
    user: resolve(userHome, ".config", "seqlane", "workflows"),
  };
}

function parseDescriptor(
  contents: string,
  descriptorPath: string,
): WorkflowDescriptor {
  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch {
    throw new Error(
      `Workflow descriptor "${descriptorPath}" is not valid JSON`,
    );
  }

  const result = workflowDescriptorSchema.safeParse(value);
  if (result.success) return result.data;

  const issue = result.error.issues[0];
  const issuePath = issue?.path.length === 0 ? "root" : issue?.path.join(".");
  throw new Error(
    `Workflow descriptor "${descriptorPath}" is invalid at ${issuePath ?? "root"}: ${issue?.message ?? "invalid descriptor"}`,
  );
}

function resolveDescriptorModule(
  moduleSpecifier: string,
  descriptorPath: string,
): string {
  if (moduleSpecifier.startsWith(".") || moduleSpecifier.startsWith("/")) {
    return pathToFileURL(resolve(dirname(descriptorPath), moduleSpecifier))
      .href;
  }

  if (moduleSpecifier.startsWith("file:")) {
    try {
      return new URL(moduleSpecifier).href;
    } catch {
      throw new Error(
        `Workflow descriptor "${descriptorPath}" has an invalid file URL module reference`,
      );
    }
  }

  return moduleSpecifier;
}

function readScopeRoot(
  root: string,
  scope: WorkflowScope,
): DiscoveredWorkflow[] {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`Could not read ${scope} workflow root "${root}"`, {
      cause: error,
    });
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const descriptorPath = resolve(root, entry.name);
      const descriptor = parseDescriptor(
        readFileSync(descriptorPath, "utf8"),
        descriptorPath,
      );
      const qualifiedName = `${scope}:${descriptor.name}`;
      return {
        descriptor,
        descriptorPath,
        scope,
        qualifiedName,
        reference: {
          id: qualifiedName,
          moduleSpecifier: resolveDescriptorModule(
            descriptor.moduleSpecifier,
            descriptorPath,
          ),
          exportName: descriptor.exportName,
        },
      };
    });
}

export function discoverWorkflowDescriptors(
  roots: WorkflowRoots = defaultWorkflowRoots(),
): readonly DiscoveredWorkflow[] {
  const workflows = [
    ...readScopeRoot(roots.repository, "repository"),
    ...readScopeRoot(roots.user, "user"),
  ].sort((left, right) =>
    left.qualifiedName.localeCompare(right.qualifiedName),
  );

  const duplicates = new Map<string, DiscoveredWorkflow[]>();
  for (const workflow of workflows) {
    const matches = duplicates.get(workflow.qualifiedName) ?? [];
    matches.push(workflow);
    duplicates.set(workflow.qualifiedName, matches);
  }
  for (const [qualifiedName, matches] of duplicates) {
    if (matches.length < 2) continue;
    throw new Error(
      `Workflow discovery found duplicate ${qualifiedName} descriptors: ${matches
        .map(({ descriptorPath }) => descriptorPath)
        .join(", ")}`,
    );
  }

  return workflows;
}

function resolveDiscoveredWorkflow(
  value: string,
  workflows: readonly DiscoveredWorkflow[],
): WorkflowSelection | undefined {
  const qualifiedMatch = /^(repository|user):(.+)$/.exec(value);
  if (qualifiedMatch !== null) {
    const match = workflows.find(
      ({ qualifiedName }) => qualifiedName === value,
    );
    if (match === undefined) return undefined;
    return { reference: match.reference, descriptor: match };
  }

  const matches = workflows.filter(
    ({ descriptor }) => descriptor.name === value,
  );
  if (matches.length === 1) {
    const [match] = matches;
    if (match !== undefined)
      return { reference: match.reference, descriptor: match };
  }
  if (matches.length > 1) {
    throw new Error(
      `Workflow name "${value}" is ambiguous. Use one of: ${matches
        .map(({ qualifiedName }) => qualifiedName)
        .join(", ")}`,
    );
  }
  return undefined;
}

export function resolveWorkflowSelection(
  value: string,
  workflows?: readonly DiscoveredWorkflow[],
): WorkflowSelection {
  const availableWorkflows =
    workflows ??
    (isExplicitWorkflowReference(value) ? [] : discoverWorkflowDescriptors());
  const discovered = resolveDiscoveredWorkflow(value, availableWorkflows);
  if (discovered !== undefined) return discovered;

  if (isDirectWorkflowReference(value)) {
    return { reference: parseWorkflowReference(value) };
  }

  throw new Error(
    `Workflow "${value}" was not found. Use a qualified name or a direct module reference.`,
  );
}

export function listWorkflowRecord(workflow: DiscoveredWorkflow): {
  readonly name: string;
  readonly scope: WorkflowScope;
  readonly qualifiedName: string;
  readonly moduleSpecifier: string;
  readonly exportName: string;
  readonly description: string;
} {
  return {
    ...workflow.descriptor,
    scope: workflow.scope,
    qualifiedName: workflow.qualifiedName,
  };
}
