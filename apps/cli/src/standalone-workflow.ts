import type { LoadedWorkflow } from "@seqlane/runtime/workflow";
import type { WorkflowReference } from "@seqlane/protocol";
import { compileWorkflowExport } from "@seqlane/runtime/workflow";
import { parseTsconfig } from "get-tsconfig";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { registerHooks } from "node:module";
import {
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workflowExtensions = new Set([".ts", ".mts", ".js", ".mjs"]);

export interface StandaloneWorkflowReference extends WorkflowReference {
  readonly sourcePath?: string;
}

/** A standalone workflow plus the import hooks needed while it executes. */
export interface LoadedStandaloneWorkflow extends LoadedWorkflow {
  /** Release the loader after workflow execution and any dynamic imports finish. */
  readonly dispose: () => Promise<void>;
}

function callerPath(callerDirectory: string): string {
  return resolve(callerDirectory);
}

function splitReference(value: string): {
  readonly moduleSpecifier: string;
  readonly exportName: string;
} {
  const separator = value.lastIndexOf("#");
  if (separator === -1)
    return { moduleSpecifier: value, exportName: "default" };
  if (separator === 0 || separator === value.length - 1) {
    throw new Error("workflow must have a module reference and export name");
  }
  return {
    moduleSpecifier: value.slice(0, separator),
    exportName: value.slice(separator + 1),
  };
}

function isFileReference(value: string): boolean {
  return (
    value.startsWith(".") ||
    value.startsWith("/") ||
    value.startsWith("file:") ||
    (!value.includes("/") && workflowExtensions.has(extname(value)))
  );
}

function fileReferencePath(value: string, callerDirectory: string): string {
  try {
    return value.startsWith("file:")
      ? fileURLToPath(value)
      : resolve(callerDirectory, value);
  } catch {
    throw new Error("workflow file reference must be a valid path or file URL");
  }
}

async function resolveFileReference(
  value: string,
  callerDirectory: string,
): Promise<string> {
  const path = fileReferencePath(value, callerDirectory);
  if (!workflowExtensions.has(extname(path))) {
    throw new Error(
      "workflow file must use a .ts, .mts, .js, or .mjs extension",
    );
  }
  let details: Awaited<ReturnType<typeof stat>>;
  try {
    details = await stat(path);
  } catch (error) {
    throw new Error(`workflow file could not be read: ${String(error)}`, {
      cause: error,
    });
  }
  if (!details.isFile())
    throw new Error("workflow file reference must identify a file");
  return path;
}

/** Resolves one explicit file or package entrypoint from the caller project. */
export async function resolveStandaloneWorkflowReference(
  value: string,
  callerDirectory: string,
): Promise<StandaloneWorkflowReference> {
  const parsed = splitReference(value);
  if (parsed.moduleSpecifier.length === 0) {
    throw new Error("workflow reference must not be empty");
  }

  if (
    parsed.moduleSpecifier.startsWith("repository:") ||
    parsed.moduleSpecifier.startsWith("user:") ||
    (/^[a-z][a-z+.-]*:/i.test(parsed.moduleSpecifier) &&
      !parsed.moduleSpecifier.startsWith("file:"))
  ) {
    throw new Error(
      "workflow reference must be a local file or installed package",
    );
  }

  if (isFileReference(parsed.moduleSpecifier)) {
    const sourcePath = await resolveFileReference(
      parsed.moduleSpecifier,
      callerPath(callerDirectory),
    );
    return {
      id: value,
      moduleSpecifier: pathToFileURL(sourcePath).href,
      exportName: parsed.exportName,
      sourcePath,
    };
  }

  return {
    id: value,
    moduleSpecifier: parsed.moduleSpecifier,
    exportName: parsed.exportName,
  };
}

async function nearestTsconfig(path: string): Promise<string | undefined> {
  let directory = resolve(path, "..");
  while (true) {
    const candidate = resolve(directory, "tsconfig.json");
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Continue toward the filesystem root.
    }
    const parent = resolve(directory, "..");
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function requireSupportedTsconfig(tsconfig: string | undefined): void {
  if (tsconfig === undefined) return;
  if ((parseTsconfig(tsconfig).compilerOptions?.plugins?.length ?? 0) > 0) {
    throw new Error(
      "workflow TypeScript configuration uses compiler plugins, which standalone runs do not support",
    );
  }
}

let tsImportApi: Promise<typeof import("tsx/esm/api")> | undefined;

async function tsxApi(): Promise<typeof import("tsx/esm/api")> {
  process.env.TSX_DISABLE_CACHE = "1";
  tsImportApi ??= import("tsx/esm/api");
  return tsImportApi;
}

function modulePathFor(url: string): string | undefined {
  if (!url.startsWith("file:")) return undefined;
  try {
    return realpathSync(fileURLToPath(url));
  } catch {
    return undefined;
  }
}

function packageRootForPath(path: string): string | undefined {
  let directory = dirname(path);
  while (true) {
    if (existsSync(resolve(directory, "package.json"))) return directory;
    const parent = resolve(directory, "..");
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function isWithin(path: string, directory: string): boolean {
  const relativePath = relative(directory, path);
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

function isSourceModuleUrl(
  url: string,
  sourceModules: ReadonlySet<string>,
): boolean {
  const path = modulePathFor(url);
  return (
    path !== undefined &&
    sourceModules.has(path) &&
    workflowExtensions.has(extname(path))
  );
}

interface StandaloneModuleLoader {
  readonly importModule: () => Promise<Record<string, unknown>>;
  readonly dispose: () => Promise<void>;
}

async function createStandaloneModuleLoader(
  reference: StandaloneWorkflowReference,
  callerDirectory: string,
): Promise<StandaloneModuleLoader> {
  const parentURL = pathToFileURL(
    resolve(callerPath(callerDirectory), ".seqlane-entrypoint.mjs"),
  ).href;
  if (reference.sourcePath === undefined) {
    const packageLoader = (await tsxApi()).register({
      namespace: randomUUID(),
      tsconfig: false,
    });
    return {
      importModule: async () =>
        (await packageLoader.import(
          reference.moduleSpecifier,
          parentURL,
        )) as Record<string, unknown>,
      dispose: () => packageLoader.unregister(),
    };
  }
  const tsconfig = await nearestTsconfig(reference.sourcePath);
  requireSupportedTsconfig(tsconfig);
  const unregister = (await tsxApi()).register({ tsconfig: tsconfig ?? false });
  const sourceRoot = dirname(tsconfig ?? reference.sourcePath);
  const sourcePackageRoot = packageRootForPath(reference.sourcePath);
  let formatHooks: ReturnType<typeof registerHooks> | undefined;
  const sourceModules = new Set([realpathSync(reference.sourcePath)]);

  try {
    formatHooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        const resolved = nextResolve(specifier, context);
        const resolvedPath = modulePathFor(resolved.url);
        const parentPath =
          context.parentURL === undefined
            ? undefined
            : modulePathFor(context.parentURL);
        const isRelativeImport =
          specifier.startsWith(".") ||
          specifier.startsWith("/") ||
          specifier.startsWith("file:");
        const isSourceAlias =
          !isRelativeImport &&
          resolvedPath !== undefined &&
          isWithin(resolvedPath, sourceRoot) &&
          (packageRootForPath(resolvedPath) === undefined ||
            packageRootForPath(resolvedPath) === sourcePackageRoot);
        if (
          resolvedPath !== undefined &&
          workflowExtensions.has(extname(resolvedPath)) &&
          ((parentPath !== undefined &&
            sourceModules.has(parentPath) &&
            isRelativeImport) ||
            isSourceAlias)
        ) {
          sourceModules.add(resolvedPath);
        }
        return isSourceModuleUrl(resolved.url, sourceModules)
          ? { ...resolved, format: "module" }
          : resolved;
      },
      load(url, context, nextLoad) {
        return nextLoad(
          url,
          isSourceModuleUrl(url, sourceModules)
            ? { ...context, format: "module" }
            : context,
        );
      },
    });

    return {
      importModule: async () =>
        (await import(reference.moduleSpecifier)) as Record<string, unknown>,
      dispose: async () => {
        formatHooks?.deregister();
        await unregister();
      },
    };
  } catch (error) {
    formatHooks?.deregister();
    await unregister();
    throw error;
  }
}

/** Imports and validates one authored standalone workflow definition. */
export async function loadStandaloneWorkflow(
  value: string,
  callerDirectory: string,
): Promise<LoadedStandaloneWorkflow> {
  const reference = await resolveStandaloneWorkflowReference(
    value,
    callerDirectory,
  );
  const moduleLoader = await createStandaloneModuleLoader(
    reference,
    callerDirectory,
  );
  try {
    const module = await moduleLoader.importModule();
    if (!Object.hasOwn(module, reference.exportName)) {
      throw new Error(
        `Workflow module "${reference.moduleSpecifier}" does not export "${reference.exportName}"`,
      );
    }
    const loaded = compileWorkflowExport(
      reference,
      module[reference.exportName],
    );
    return { ...loaded, dispose: moduleLoader.dispose };
  } catch (error) {
    await moduleLoader.dispose();
    throw error;
  }
}
