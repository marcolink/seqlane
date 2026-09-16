import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  loadStandaloneWorkflow,
  resolveStandaloneWorkflowReference,
} from "./standalone-workflow.js";
import {
  prepareStandaloneWorkspace,
  readStandaloneInput,
} from "./standalone-execution-preparation.js";

const temporaryDirectories: string[] = [];
const loadedWorkflows: Array<{ readonly dispose: () => Promise<void> }> = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    loadedWorkflows.splice(0).map((workflow) => workflow.dispose()),
  );
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await import("node:fs/promises").then(({ rm }) =>
        rm(directory, { force: true, recursive: true }),
      );
    }),
  );
});

async function loadWorkflow(value: string, callerDirectory: string) {
  const loaded = await loadStandaloneWorkflow(value, callerDirectory);
  loadedWorkflows.push(loaded);
  return loaded;
}

async function createProject(withPackageJson = true): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "seqlane-standalone-"));
  temporaryDirectories.push(directory);
  if (withPackageJson) {
    await writeFile(join(directory, "package.json"), '{"type":"module"}\n');
  }
  await mkdir(join(directory, "node_modules", "@seqlane"), { recursive: true });
  await symlink(
    resolve(fileURLToPath(new URL("../../../", import.meta.url)), "libs/core"),
    join(directory, "node_modules", "@seqlane", "core"),
  );
  await symlink(
    dirname(fileURLToPath(import.meta.resolve("zod"))),
    join(directory, "node_modules", "zod"),
  );
  return directory;
}

function flowSource(id: string): string {
  return `
    import { createFlow } from "@seqlane/core";
    import { z } from "zod";
    const input = z.object({ value: z.string().default("default") });
    export default createFlow({ id: ${JSON.stringify(id)}, input, output: input })
      .output(({ input }) => input)
      .define();
  `;
}

describe("standalone workflow preparation", () => {
  it("loads TypeScript with the nearest config, inherited aliases, enums, .js imports, and source assets", async () => {
    const project = await createProject();
    await mkdir(join(project, "src"));
    await writeFile(
      join(project, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "#workflow/*": ["src/*"] },
        },
      }),
    );
    await writeFile(
      join(project, "src", "tsconfig.json"),
      '{"extends":"../tsconfig.json"}',
    );
    await writeFile(
      join(project, "src", "helper.ts"),
      'export enum Helper { value = "helper" }\nexport const helper = Helper.value;\n',
    );
    await writeFile(
      join(project, "src", "alias.ts"),
      'export const alias = "alias";\n',
    );
    await writeFile(join(project, "src", "asset.txt"), "asset");
    await writeFile(
      join(project, "src", "entry.ts"),
      `
        import { createFlow } from "@seqlane/core";
        import { z } from "zod";
        import { helper } from "./helper.js";
        import { alias } from "#workflow/alias";
        import { readFile } from "node:fs/promises";
        const asset = await readFile(new URL("./asset.txt", import.meta.url), "utf8");
        const input = z.object({ value: z.string().default(helper + alias + asset) });
        export default createFlow({ id: "configured-source", input, output: input })
          .output(({ input }) => input)
          .define();
      `,
    );

    const probe = join(project, "probe.mjs");
    await writeFile(
      probe,
      `
        import { loadStandaloneWorkflow } from ${JSON.stringify(
          new URL("../dist/standalone-workflow.js", import.meta.url).href,
        )};
        const loaded = await loadStandaloneWorkflow("./src/entry.ts", process.cwd());
        console.log(JSON.stringify({ id: loaded.definition.id, input: loaded.definition.input.parse({}) }));
        await loaded.dispose();
      `,
    );
    const { stdout } = await execFileAsync(process.execPath, [probe], {
      cwd: project,
    });

    expect(JSON.parse(stdout)).toEqual({
      id: "configured-source",
      input: { value: "helperaliasasset" },
    });
    expect(await readdir(project)).not.toContain("dist");
    expect(await readdir(join(project, "src"))).toEqual(
      expect.arrayContaining(["asset.txt", "entry.ts", "helper.ts"]),
    );
  });

  it("keeps unconfigured TypeScript ESM imports active without a package manifest", async () => {
    const project = await createProject(false);
    const cacheDirectory = join(project, "tsx-cache");
    await mkdir(cacheDirectory);
    await mkdir(join(project, "src"));
    await writeFile(join(project, "asset.txt"), "asset");
    await writeFile(
      join(project, "shared.ts"),
      'export enum Helper { value = "helper" }\n',
    );
    await writeFile(
      join(project, "late.ts"),
      'export const runtime = "dynamic";\n',
    );
    await writeFile(
      join(project, "src", "main.ts"),
      `
        import { createFlow } from "@seqlane/core";
        import { z } from "zod";
        import { readFile } from "node:fs/promises";
        import { Helper } from "../shared.js";
        const asset = await readFile(new URL("../asset.txt", import.meta.url), "utf8");
        globalThis.seqlaneStandaloneDynamicImport = async () => {
          const { runtime } = await import("../late.js");
          return runtime;
        };
        const input = z.object({ value: z.string().default(Helper.value + asset) });
        export default createFlow({ id: "esm-source", input, output: input })
          .output(({ input }) => input)
          .define();
      `,
    );
    const probe = join(project, "probe.mjs");
    await writeFile(
      probe,
      `
        import { loadStandaloneWorkflow } from ${JSON.stringify(
          new URL("../dist/standalone-workflow.js", import.meta.url).href,
        )};
        const loaded = await loadStandaloneWorkflow("./src/main.ts", process.cwd());
        const input = loaded.definition.input.parse({});
        const dynamic = await globalThis.seqlaneStandaloneDynamicImport();
        console.log(JSON.stringify({ input, dynamic }));
        await loaded.dispose();
      `,
    );

    const { stdout } = await execFileAsync(process.execPath, [probe], {
      cwd: project,
      env: { ...process.env, TMPDIR: cacheDirectory, TSX_DISABLE_CACHE: "" },
    });

    expect(JSON.parse(stdout)).toEqual({
      input: { value: "helperasset" },
      dynamic: "dynamic",
    });
    expect(await readdir(cacheDirectory)).toEqual([]);
  });

  it("loads configured TypeScript without a package manifest", async () => {
    const project = await createProject(false);
    await writeFile(
      join(project, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@source/*": ["src/*"] } },
      }),
    );
    await mkdir(join(project, "src"));
    const helperDirectory = join(project, "packages", "cjs-helper");
    await mkdir(helperDirectory, { recursive: true });
    await writeFile(
      join(helperDirectory, "package.json"),
      JSON.stringify({ exports: "./index.js" }),
    );
    await writeFile(
      join(helperDirectory, "index.js"),
      'module.exports = { suffix: "-cjs" };\n',
    );
    await symlink(helperDirectory, join(project, "node_modules", "cjs-helper"));
    await writeFile(
      join(project, "src", "helper.ts"),
      'export const value = "ok";\n',
    );
    await writeFile(
      join(project, "src", "entry.ts"),
      `
        import { createFlow } from "@seqlane/core";
        import { z } from "zod";
        import { value } from "@source/helper";
        import cjsHelper from "cjs-helper";
        const input = z.object({ value: z.string().default(value + cjsHelper.suffix) });
        export default createFlow({ id: "configured-no-package", input, output: input })
          .output(({ input }) => input)
          .define();
      `,
    );

    const probe = join(project, "probe.mjs");
    await writeFile(
      probe,
      `
        import { loadStandaloneWorkflow } from ${JSON.stringify(
          new URL("../dist/standalone-workflow.js", import.meta.url).href,
        )};
        const loaded = await loadStandaloneWorkflow("./src/entry.ts", process.cwd());
        console.log(JSON.stringify(loaded.definition.input.parse({})));
        await loaded.dispose();
      `,
    );
    const { stdout } = await execFileAsync(process.execPath, [probe], {
      cwd: project,
    });

    expect(JSON.parse(stdout)).toEqual({ value: "ok-cjs" });
  });

  it("resolves a package through the caller's ESM import condition", async () => {
    const project = await createProject();
    const packageDirectory = join(
      project,
      "node_modules",
      "@acme",
      "workflows",
    );
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(
      join(packageDirectory, "package.json"),
      JSON.stringify({
        type: "module",
        exports: { ".": { import: "./import.mjs", default: "./default.mjs" } },
      }),
    );
    await writeFile(
      join(packageDirectory, "import.mjs"),
      flowSource("import-condition"),
    );
    await writeFile(
      join(packageDirectory, "default.mjs"),
      flowSource("default-condition"),
    );

    const loaded = await loadWorkflow("@acme/workflows", project);

    expect(loaded.definition.id).toBe("import-condition");
  });

  it("loads a named package subpath export", async () => {
    const project = await createProject();
    const packageDirectory = join(
      project,
      "node_modules",
      "@acme",
      "workflows",
    );
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(
      join(packageDirectory, "package.json"),
      JSON.stringify({
        type: "module",
        exports: { "./review": "./review.mjs" },
      }),
    );
    await writeFile(
      join(packageDirectory, "review.mjs"),
      `${flowSource("named-package").replace("export default", "export const review =")}`,
    );

    const loaded = await loadWorkflow("@acme/workflows/review#review", project);

    expect(loaded.definition.id).toBe("named-package");
  });

  it("rejects un-authored exports and invalid references", async () => {
    const project = await createProject();
    await writeFile(
      join(project, "invalid.mjs"),
      "export default { id: 'invalid' };\n",
    );

    await expect(
      loadStandaloneWorkflow("./invalid.mjs", project),
    ).rejects.toThrow("must be an authored Seqlane workflow definition");
    await expect(
      resolveStandaloneWorkflowReference("./", project),
    ).rejects.toThrow(".ts, .mts, .js, or .mjs");
    await expect(
      resolveStandaloneWorkflowReference("./workflow.tsx", project),
    ).rejects.toThrow(".ts, .mts, .js, or .mjs");
    await expect(
      resolveStandaloneWorkflowReference("./invalid.mjs#", project),
    ).rejects.toThrow("module reference and export name");
    await expect(
      resolveStandaloneWorkflowReference(
        "data:text/javascript,export default 1",
        project,
      ),
    ).rejects.toThrow("local file or installed package");
    await expect(
      resolveStandaloneWorkflowReference("repository:review", project),
    ).rejects.toThrow("local file or installed package");
  });

  it("rejects TypeScript compiler plugins before importing the workflow", async () => {
    const project = await createProject(false);
    await writeFile(
      join(project, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { plugins: [{ name: "custom" }] } }),
    );
    await writeFile(
      join(project, "entry.ts"),
      "throw new Error('imported');\n",
    );

    await expect(loadStandaloneWorkflow("./entry.ts", project)).rejects.toThrow(
      "uses compiler plugins",
    );
  });

  it("reads only explicit bounded JSON input and resolves workspaces independently", async () => {
    const project = await createProject();
    await mkdir(join(project, "workspace"));
    await writeFile(join(project, "input.json"), '{"value":false}');
    await writeFile(join(project, "invalid.json"), "{");
    await writeFile(join(project, "invalid-utf8.json"), Buffer.from([0xff]));
    await writeFile(join(project, "oversize.json"), " ".repeat(1_048_577));
    let stdinRead = false;
    const unreadStdin = {
      async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
        stdinRead = true;
        yield Buffer.from('{"unexpected":true}');
      },
    };

    await expect(
      readStandaloneInput({ callerDirectory: project, stdin: unreadStdin }),
    ).resolves.toEqual({});
    expect(stdinRead).toBe(false);
    await expect(
      readStandaloneInput({
        callerDirectory: project,
        input: "null",
        inputFile: "input.json",
      }),
    ).rejects.toThrow("cannot be combined");
    await expect(
      readStandaloneInput({
        callerDirectory: project,
        inputFile: "input.json",
      }),
    ).resolves.toEqual({ value: false });
    await expect(
      readStandaloneInput({
        callerDirectory: project,
        input: "x".repeat(1_048_577),
      }),
    ).rejects.toThrow("exceeds the 1048576-byte limit");
    await expect(
      readStandaloneInput({
        callerDirectory: project,
        inputFile: "oversize.json",
      }),
    ).rejects.toThrow("exceeds the 1048576-byte limit");
    await expect(
      readStandaloneInput({
        callerDirectory: project,
        inputFile: "invalid.json",
      }),
    ).rejects.toThrow("must contain one valid JSON value");
    await expect(
      readStandaloneInput({
        callerDirectory: project,
        inputFile: "invalid-utf8.json",
      }),
    ).rejects.toThrow("must be UTF-8");
    await expect(
      readStandaloneInput({
        callerDirectory: project,
        inputFile: "missing.json",
      }),
    ).rejects.toThrow("could not be read");
    await expect(
      readStandaloneInput({
        callerDirectory: project,
        inputFile: "-",
        stdin: (async function* () {
          yield Buffer.from('{"stdin":true}');
        })(),
      }),
    ).resolves.toEqual({ stdin: true });
    await expect(
      prepareStandaloneWorkspace(project, "workspace"),
    ).resolves.toBe(join(project, "workspace"));
    await expect(
      prepareStandaloneWorkspace(project, "input.json"),
    ).rejects.toThrow("must be a directory");
  });
});
