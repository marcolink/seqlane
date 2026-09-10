// @test-scope ./workflow-discovery.ts
// @test-scope ./workflow-reference.ts
// @test-scope ./commands/list.ts
// @test-scope ./commands/plan.ts
// @test-scope ./commands/run.ts
// @test-scope ./cli-contracts.ts
// @test-scope ./human-output.ts
// @test-scope ./workflow-roots.ts

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverWorkflowDescriptors,
  listWorkflowRecord,
  resolveWorkflowSelection,
  type WorkflowRoots,
} from "./workflow-discovery.js";
import { renderWorkflowListHuman } from "./commands/list.js";
import { createPlanCommandResult, renderPlanHuman } from "./commands/plan.js";
import { createRunRequest } from "./commands/run.js";
import {
  planCommandResultSchema,
  workflowListResultSchema,
} from "./cli-contracts.js";

function createRoots(): {
  readonly roots: WorkflowRoots;
  readonly directory: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "seqlane-discovery-"));
  const roots = {
    repository: join(directory, "repository"),
    user: join(directory, "user"),
  };
  mkdirSync(roots.repository);
  mkdirSync(roots.user);
  return { roots, directory };
}

function writeDescriptor(
  root: string,
  fileName: string,
  descriptor: Record<string, unknown>,
): void {
  writeFileSync(join(root, fileName), JSON.stringify(descriptor));
}

const descriptor = (name: string, moduleSpecifier = "./workflow.mjs") => ({
  name,
  moduleSpecifier,
  exportName: "default",
  description: `${name} workflow`,
});

describe("workflow discovery", () => {
  it("discovers repository and user descriptors in deterministic order", () => {
    const { roots, directory } = createRoots();
    try {
      writeDescriptor(roots.user, "zeta.json", descriptor("zeta"));
      writeDescriptor(roots.repository, "alpha.json", descriptor("alpha"));

      const workflows = discoverWorkflowDescriptors(roots);

      expect(workflows.map(({ qualifiedName }) => qualifiedName)).toEqual([
        "repository:alpha",
        "user:zeta",
      ]);
      expect(workflows[0]?.reference.moduleSpecifier).toMatch(
        /^file:\/\/.*repository\/workflow\.mjs$/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("resolves qualified and unique unqualified names", () => {
    const { roots, directory } = createRoots();
    try {
      writeDescriptor(roots.repository, "review.json", descriptor("review"));
      writeDescriptor(roots.user, "personal.json", descriptor("personal"));
      const workflows = discoverWorkflowDescriptors(roots);

      expect(
        resolveWorkflowSelection("repository:review", workflows).reference.id,
      ).toBe("repository:review");
      expect(resolveWorkflowSelection("personal", workflows).reference.id).toBe(
        "user:personal",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("resolves discovered extension-shaped names before direct file references", () => {
    const { roots, directory } = createRoots();
    try {
      writeDescriptor(roots.repository, "review.json", descriptor("review.ts"));
      const workflows = discoverWorkflowDescriptors(roots);

      expect(
        resolveWorkflowSelection("review.ts", workflows).reference,
      ).toMatchObject({
        id: "repository:review.ts",
      });
      expect(
        createRunRequest(
          "review.ts",
          "null",
          undefined,
          undefined,
          false,
          roots,
        ).workflow,
      ).toMatchObject({ id: "repository:review.ts" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports every qualified match for an ambiguous name", () => {
    const { roots, directory } = createRoots();
    try {
      writeDescriptor(roots.repository, "review.json", descriptor("review"));
      writeDescriptor(roots.user, "review.json", descriptor("review"));
      const workflows = discoverWorkflowDescriptors(roots);

      expect(() => resolveWorkflowSelection("review", workflows)).toThrow(
        'Workflow name "review" is ambiguous. Use one of: repository:review, user:review',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed descriptors before any module import", () => {
    const { roots, directory } = createRoots();
    try {
      writeFileSync(join(roots.repository, "broken.json"), "not-json");

      expect(() => discoverWorkflowDescriptors(roots)).toThrow(
        /broken\.json.*not valid JSON/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("lists descriptors without importing workflow source", () => {
    const { roots, directory } = createRoots();
    try {
      const marker = join(directory, "imported");
      const modulePath = join(roots.repository, "workflow.mjs");
      writeFileSync(
        modulePath,
        `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "imported"); export default {};`,
      );
      writeDescriptor(roots.repository, "review.json", descriptor("review"));

      const records =
        discoverWorkflowDescriptors(roots).map(listWorkflowRecord);

      expect(records).toEqual([
        {
          name: "review",
          scope: "repository",
          qualifiedName: "repository:review",
          moduleSpecifier: "./workflow.mjs",
          exportName: "default",
          description: "review workflow",
        },
      ]);
      expect(workflowListResultSchema.parse(records)).toEqual(records);
      expect(existsSync(marker)).toBe(false);
      expect(renderWorkflowListHuman(records)).toContain("repository:review");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("escapes terminal control characters in human output", async () => {
    const { roots, directory } = createRoots();
    try {
      const unsafe = "\u001b[31munsafe\nvalue";
      writeDescriptor(roots.repository, "unsafe.json", {
        name: "unsafe",
        moduleSpecifier: `./${unsafe}.mjs`,
        exportName: unsafe,
        description: unsafe,
      });
      const records =
        discoverWorkflowDescriptors(roots).map(listWorkflowRecord);

      expect(renderWorkflowListHuman(records)).toContain(
        "\\u001b[31munsafe\\nvalue",
      );
      expect(renderWorkflowListHuman(records)).not.toContain("\u001b");

      const modulePath = join(roots.repository, "workflow.mjs");
      writeFileSync(
        modulePath,
        `
          import { z } from "zod";
          const schema = z.unknown();
          const task = { id: "unsafe-task", input: schema, output: schema, execute: async () => ({}) };
          export default { id: "unsafe-plan", input: schema, output: schema, build: ({ input, run }) => run(task, { input }).output };
        `,
      );
      writeDescriptor(roots.repository, "plan.json", descriptor("plan"));
      const result = await createPlanCommandResult("plan", null, roots);
      const unsafeResult = {
        ...result,
        workflow: {
          ...result.workflow,
          description: unsafe,
          moduleSpecifier: unsafe,
        },
        plan: {
          ...result.plan,
          nodes: result.plan.nodes.map((node) => ({
            ...node,
            label: unsafe,
          })),
        },
      };

      expect(renderPlanHuman(unsafeResult)).toContain(
        "\\u001b[31munsafe\\nvalue",
      );
      expect(renderPlanHuman(unsafeResult)).not.toContain("\u001b");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps direct file and module references compatible", () => {
    const { roots, directory } = createRoots();
    try {
      const workflows = discoverWorkflowDescriptors(roots);

      expect(
        resolveWorkflowSelection("./workflow.mjs", workflows).reference,
      ).toMatchObject({ exportName: "default" });
      expect(
        resolveWorkflowSelection(
          "@seqlane/fixtures/renovate-workflow#renovateWorkflow",
          workflows,
        ).reference,
      ).toMatchObject({
        moduleSpecifier: "@seqlane/fixtures/renovate-workflow",
        exportName: "renovateWorkflow",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("plans a workflow without invoking its task", async () => {
    const { roots, directory } = createRoots();
    try {
      const modulePath = join(roots.repository, "workflow.mjs");
      writeFileSync(
        modulePath,
        `
          import { z } from "zod";
          const schema = z.unknown();
          const task = { id: "never-executed", input: schema, output: schema, execute: async () => { throw new Error("task executed"); } };
          export default { id: "plan-only", input: schema, output: schema, build: ({ input, run }) => run(task, { input }).output };
        `,
      );
      writeDescriptor(roots.repository, "plan.json", descriptor("plan"));

      const result = await createPlanCommandResult("plan", null, roots);

      expect(result.plan.workflow.id).toBe("plan-only");
      expect(result.plan.nodes).toMatchObject([{ taskId: "never-executed" }]);
      expect(result.plan.nodes[0]).not.toHaveProperty("execution");
      expect(renderPlanHuman(result)).toContain("never-executed");
      expect(planCommandResultSchema.parse(result)).toEqual(result);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("resolves discovered run references and does not discover direct references", () => {
    const { roots, directory } = createRoots();
    try {
      writeDescriptor(roots.repository, "review.json", descriptor("review"));
      writeDescriptor(roots.user, "personal.json", descriptor("personal"));

      expect(
        createRunRequest(
          "repository:review",
          "null",
          undefined,
          undefined,
          false,
          roots,
        ).workflow,
      ).toMatchObject({ id: "repository:review" });
      expect(
        createRunRequest(
          "user:personal",
          "null",
          undefined,
          undefined,
          false,
          roots,
        ).workflow,
      ).toMatchObject({ id: "user:personal" });
      expect(
        createRunRequest("personal", "null", undefined, undefined, false, roots)
          .workflow,
      ).toMatchObject({ id: "user:personal" });

      expect(
        createRunRequest(
          "./workflow.mjs",
          "null",
          undefined,
          undefined,
          false,
          {
            repository: join(directory, "missing"),
            user: join(directory, "also-missing"),
          },
        ).workflow,
      ).toMatchObject({ exportName: "default" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
