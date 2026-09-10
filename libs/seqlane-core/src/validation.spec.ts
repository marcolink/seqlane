// @test-scope ./dsl.ts
// @test-scope ./builder.ts
// @test-scope ./errors.ts

import { describe, expect, it } from "vitest";
import {
  buildWorkflow,
  createFlow,
  defineAgentTask,
  defineValidator,
  defineWorkflow,
  validatedBy,
  ValidationFailedError,
  type ValidationResult,
} from "./index.js";
import { z } from "zod";

const schema = <T>() => z.custom<T>(() => true);

describe("semantic validation core contracts", () => {
  it("keeps validation results JSON-safe and uses success as the verdict", () => {
    const result: ValidationResult = {
      success: false,
      issues: [
        {
          code: "missing-title",
          message: "The title is required",
          path: "/title",
        },
      ],
      evidence: { checkedFields: ["title"] },
    };

    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("collects mechanical validators and lowers a serializable check/gate pair", () => {
    const validator = defineValidator({
      id: "title-quality",
      input: schema<{ readonly title: string }>(),
      validate: ({ title }) =>
        title.length > 0
          ? { success: true, evidence: { length: title.length } }
          : {
              success: false,
              issues: [{ code: "empty", message: "Title must not be empty" }],
            },
    });
    const workflow = defineWorkflow({
      id: "validation-plan",
      input: schema<{ readonly title: string }>(),
      output: schema<{ readonly title: string }>(),
      build: ({ input, validate }) => {
        const invocation = validate(validator, { input });
        return { title: invocation.output.title };
      },
    });

    const built = buildWorkflow(workflow);

    expect(built.validatorDefinitions.get("title-quality")).toBe(validator);
    expect(built.plan.nodes).toEqual([
      {
        type: "validation.check",
        nodeId: "validation.check:1",
        source: { type: "mechanical", validatorId: "title-quality" },
        input: {
          type: "ref",
          nodeId: "__seqlane_input",
          path: [],
        },
        dependsOn: [],
      },
      {
        type: "validation.gate",
        nodeId: "validation.gate:1",
        input: {
          type: "ref",
          nodeId: "__seqlane_input",
          path: [],
        },
        checkNodeId: "validation.check:1",
        policy: "fail",
        dependsOn: ["validation.check:1"],
      },
    ]);
    expect(JSON.stringify(built.plan)).not.toContain("validate");
    expect(JSON.stringify(built.plan)).not.toContain("Title must not be empty");
  });

  it("accepts an evaluator task directly without putting its definition in the Plan", () => {
    const evaluator = defineAgentTask({
      id: "title-evaluator",
      input: schema<{ readonly title: string }>(),
      output: schema<ValidationResult>(),
      goal: () => "Evaluate title",
    });
    const workflow = defineWorkflow({
      id: "evaluator-plan",
      input: schema<{ readonly title: string }>(),
      output: schema<{ readonly title: string }>(),
      build: ({ input, validate }) => ({
        title: validate(evaluator, { input, workspace: "shared" }).output.title,
      }),
    });

    const built = buildWorkflow(workflow);

    expect(built.taskDefinitions.get("title-evaluator")).toBe(evaluator);
    expect(built.plan.nodes[0]).toMatchObject({
      type: "validation.check",
      source: {
        type: "task",
        taskId: "title-evaluator",
        workspace: "shared",
      },
    });
    expect(JSON.stringify(built.plan)).not.toContain("Evaluate title");
  });

  it("lowers task output validation and exposes the gated candidate", () => {
    const draftTask = defineAgentTask({
      id: "draft",
      input: schema<{ readonly title: string }>(),
      output: schema<{ readonly title: string }>(),
      goal: ({ title }) => title,
    });
    const titleValidator = defineValidator({
      id: "draft-title",
      input: schema<{ readonly title: string }>(),
      validate: ({ title }) =>
        title.length > 0
          ? { success: true }
          : {
              success: false,
              issues: [{ code: "empty", message: "Title is required" }],
            },
    });
    const publishTask = defineAgentTask({
      id: "publish",
      input: schema<{ readonly title: string }>(),
      output: schema<{ readonly published: boolean }>(),
      goal: ({ title }) => title,
    });
    const workflow = defineWorkflow({
      id: "validated-task-output",
      input: schema<{ readonly title: string }>(),
      output: schema<{ readonly published: boolean }>(),
      build: ({ input, run }) => {
        const draft = run(draftTask, {
          input,
          validateOutput: titleValidator,
        });
        return run(publishTask, {
          input: { title: draft.output.title },
        }).output;
      },
    });

    expect(buildWorkflow(workflow).plan).toEqual({
      workflow: { id: "validated-task-output" },
      nodes: [
        {
          type: "task",
          taskId: "draft",
          nodeId: "draft:1",
          workspace: "exclusive",
          input: {
            type: "ref",
            nodeId: "__seqlane_input",
            path: [],
          },
          dependsOn: [],
        },
        {
          type: "validation.check",
          nodeId: "validation.check:1",
          source: { type: "mechanical", validatorId: "draft-title" },
          input: {
            type: "ref",
            nodeId: "draft:1",
            path: ["output"],
          },
          dependsOn: ["draft:1"],
        },
        {
          type: "validation.gate",
          nodeId: "validation.gate:1",
          input: {
            type: "ref",
            nodeId: "draft:1",
            path: ["output"],
          },
          checkNodeId: "validation.check:1",
          policy: "fail",
          dependsOn: ["draft:1", "validation.check:1"],
        },
        {
          type: "task",
          taskId: "publish",
          nodeId: "publish:1",
          workspace: "exclusive",
          input: {
            title: {
              type: "ref",
              nodeId: "validation.gate:1",
              path: ["value", "title"],
            },
          },
          dependsOn: ["validation.gate:1"],
        },
      ],
      output: {
        type: "ref",
        nodeId: "publish:1",
        path: ["output"],
      },
    });
  });

  it("lowers Flow validation with typed candidate and verdict handles", () => {
    const draftTask = defineAgentTask({
      id: "flow-draft",
      input: schema<{ readonly title: string }>(),
      output: schema<{ readonly title: string }>(),
      goal: ({ title }) => title,
    });
    const titleValidator = defineValidator({
      id: "flow-title",
      input: schema<{ readonly title: string }>(),
      validate: () => ({ success: true }),
    });
    const evaluator = defineAgentTask({
      id: "flow-title-evaluator",
      input: schema<{ readonly title: string }>(),
      output: schema<ValidationResult>(),
      goal: () => "Evaluate title",
    });
    const publishTask = defineAgentTask({
      id: "flow-publish",
      input: schema<{
        readonly title: string;
        readonly validation: ValidationResult;
      }>(),
      output: schema<{ readonly published: boolean }>(),
      goal: ({ title }) => title,
    });
    const flow = createFlow({
      id: "flow-validation",
      input: schema<{ readonly title: string }>(),
      output: schema<{ readonly published: boolean }>(),
    })
      .task("draft", draftTask, ({ input }) => input, {
        validateOutput: titleValidator,
      })
      .validate("checked", evaluator, ({ tasks }) => tasks.draft.output)
      .task("publish", publishTask, ({ tasks }) => ({
        title: tasks.checked.output.title,
        validation: tasks.checked.validation,
      }))
      .output(({ tasks }) => tasks.publish.output);

    const built = buildWorkflow(flow.define());

    expect(
      built.plan.nodes.map(({ type, nodeId }) => ({ type, nodeId })),
    ).toEqual([
      { type: "task", nodeId: "flow-draft:1" },
      { type: "validation.check", nodeId: "validation.check:1" },
      { type: "validation.gate", nodeId: "validation.gate:1" },
      { type: "validation.check", nodeId: "validation.check:2" },
      { type: "validation.gate", nodeId: "validation.gate:2" },
      { type: "task", nodeId: "flow-publish:1" },
    ]);
    expect(built.plan.nodes[1]).toMatchObject({
      source: { type: "mechanical", validatorId: "flow-title" },
    });
    expect(built.plan.nodes[3]).toMatchObject({
      source: {
        type: "task",
        taskId: "flow-title-evaluator",
      },
    });
    expect(built.plan.nodes[5]).toMatchObject({
      taskId: "flow-publish",
      input: {
        title: {
          type: "ref",
          nodeId: "validation.gate:2",
          path: ["value", "title"],
        },
        validation: {
          type: "ref",
          nodeId: "validation.gate:2",
          path: ["validation"],
        },
      },
    });
  });

  it("rejects distinct mechanical definitions with duplicate IDs", () => {
    const first = defineValidator({
      id: "duplicate",
      input: schema<string>(),
      validate: () => ({ success: true }),
    });
    const second = defineValidator({
      id: "duplicate",
      input: schema<string>(),
      validate: () => ({ success: true }),
    });
    const workflow = defineWorkflow({
      id: "duplicate-validator",
      input: schema<string>(),
      output: schema<string>(),
      build: ({ input, validate }) => {
        validate(first, { input });
        return validate(second, { input }).output;
      },
    });

    expect(() => buildWorkflow(workflow)).toThrow(
      'Duplicate validator definition "duplicate"',
    );
  });

  it("reports a failed validation with its category and evidence", () => {
    const error = new ValidationFailedError(
      "validation.gate:1",
      "title-quality",
      [{ code: "empty", message: "Title must not be empty" }],
      { title: "" },
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ValidationError");
    expect(error.category).toBe("ValidationError");
    expect(error.nodeId).toBe("validation.gate:1");
    expect(error.sourceId).toBe("title-quality");
    expect(error.issues).toHaveLength(1);
    expect(error.evidence).toEqual({ title: "" });
  });

  it("lowers a validated repeat postcondition to a final body gate", () => {
    const repair = defineAgentTask({
      id: "repair-state",
      input: schema<{ readonly passed: boolean }>(),
      output: schema<{ readonly passed: boolean }>(),
      goal: () => "Repair state",
    });
    const validator = defineValidator({
      id: "state-quality",
      input: schema<{ readonly passed: boolean }>(),
      validate: ({ passed }) =>
        passed
          ? { success: true }
          : {
              success: false,
              issues: [{ code: "not-ready", message: "State is not ready" }],
            },
    });

    const plan = buildWorkflow(
      createFlow({
        id: "validated-repeat",
        input: schema<{ readonly passed: boolean }>(),
        output: schema<{ readonly passed: boolean }>(),
      })
        .repeat("repair", {
          initial: ({ input }) => input,
          body: ({ input, task }) => task(repair, { input }).output,
          until: validatedBy(validator),
          maximumIterations: 3,
        })
        .output(({ tasks }) => tasks.repair.output)
        .define(),
    ).plan;

    expect(plan.nodes).toEqual([
      {
        type: "repeat",
        nodeId: "repeat:1",
        input: {
          type: "ref",
          nodeId: "__seqlane_input",
          path: [],
        },
        dependsOn: [],
        maximumIterations: 3,
        body: {
          inputNodeId: "repeat:1:input",
          nodes: [
            {
              type: "task",
              taskId: "repair-state",
              nodeId: "repeat:1/repair-state:1",
              workspace: "exclusive",
              input: {
                type: "ref",
                nodeId: "repeat:1:input",
                path: [],
              },
              dependsOn: ["repeat:1:input"],
            },
            {
              type: "validation.check",
              nodeId: "repeat:1/validation.check:1",
              source: { type: "mechanical", validatorId: "state-quality" },
              input: {
                type: "ref",
                nodeId: "repeat:1/repair-state:1",
                path: ["output"],
              },
              dependsOn: ["repeat:1/repair-state:1"],
            },
            {
              type: "validation.gate",
              nodeId: "repeat:1/validation.gate:1",
              input: {
                type: "ref",
                nodeId: "repeat:1/repair-state:1",
                path: ["output"],
              },
              checkNodeId: "repeat:1/validation.check:1",
              policy: "repeat-postcondition",
              dependsOn: [
                "repeat:1/repair-state:1",
                "repeat:1/validation.check:1",
              ],
            },
          ],
          output: {
            type: "ref",
            nodeId: "repeat:1/validation.gate:1",
            path: ["value"],
          },
          until: {
            type: "ref",
            nodeId: "repeat:1/validation.gate:1",
            path: ["validation", "success"],
          },
        },
      },
    ]);
  });
});
