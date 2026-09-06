import type { WorkflowReference } from "@seqlane/core";
import { extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workflowFileExtensions = new Set([".ts", ".mts", ".js", ".mjs"]);

export function resolveWorkflowFile(value: string): string {
  let path: string;
  try {
    path = value.startsWith("file:")
      ? fileURLToPath(value)
      : resolve(process.cwd(), value);
  } catch {
    throw new Error("workflow file reference must be a valid path or file URL");
  }

  if (!workflowFileExtensions.has(extname(path))) {
    throw new Error(
      "workflow file must use a .ts, .mts, .js, or .mjs extension",
    );
  }

  return pathToFileURL(path).href;
}

export function parseWorkflowReference(value: string): WorkflowReference {
  const separator = value.lastIndexOf("#");
  if (separator === -1) {
    return {
      id: value,
      moduleSpecifier: resolveWorkflowFile(value),
      exportName: "default",
    };
  }

  if (separator === 0 || separator === value.length - 1) {
    throw new Error(
      "workflow must be a workflow file or <module-specifier>#<export-name>",
    );
  }

  const moduleSpecifier = value.slice(0, separator);
  const exportName = value.slice(separator + 1);
  let resolvedModuleSpecifier = moduleSpecifier;

  if (moduleSpecifier.startsWith(".") || moduleSpecifier.startsWith("/")) {
    resolvedModuleSpecifier = pathToFileURL(
      resolve(process.cwd(), moduleSpecifier),
    ).href;
  } else if (moduleSpecifier.startsWith("file:")) {
    try {
      resolvedModuleSpecifier = new URL(moduleSpecifier).href;
    } catch {
      throw new Error("workflow module reference must be a valid URL");
    }
  }

  return {
    id: value,
    moduleSpecifier: resolvedModuleSpecifier,
    exportName,
  };
}

export function isDirectWorkflowReference(value: string): boolean {
  return (
    isExplicitWorkflowReference(value) ||
    workflowFileExtensions.has(extname(value))
  );
}

export function isExplicitWorkflowReference(value: string): boolean {
  if (
    value.includes("#") ||
    value.startsWith("file:") ||
    value.startsWith(".") ||
    value.startsWith("/")
  ) {
    return true;
  }
  return false;
}
