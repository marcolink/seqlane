// @test-scope ./classifier-task.ts
// @test-scope ./classifier.ts

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  classifierQuestionsSchema,
  createClassifierResultSchema,
  defineClassifierTask,
  MissingClassifierCapabilityError,
} from "./index.js";

describe("defineClassifierTask", () => {
  it("rejects an empty question declaration", () => {
    expect(() =>
      // @ts-expect-error A classifier needs at least one fixed question.
      defineClassifierTask({
        id: "classifier-empty",
        input: z.object({}),
        state: () => "example",
        questions: {},
      }),
    ).toThrow("Declare between 1 and 256 classifier questions");
  });

  it("builds a fixed Noul request from parsed input and returns the neutral result", async () => {
    const input = z.object({
      diff: z.string().transform((value) => `parsed:${value}`),
    });
    const task = defineClassifierTask({
      id: "classifier-noul",
      input,
      state: ({ diff }) => diff,
      questions: {
        needsReview: {
          kind: "noul",
          instructions: "Does this diff need review?",
        },
      },
    });
    const output = await task.execute({
      input: input.parse({ diff: "example diff" }),
      signal: new AbortController().signal,
      context: {
        exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        runAgent: async () => undefined,
        classify: async (request) => {
          expect(request).toEqual({
            state: "parsed:example diff",
            questions: {
              needsReview: {
                kind: "noul",
                instructions: "Does this diff need review?",
              },
            },
          });
          return {
            model: "jev-1.13.0",
            answers: { needsReview: { kind: "noul", probability: 0.63 } },
            usage: { inputTokens: 10, outputTokens: 2 },
          };
        },
      },
    });

    expect(output.answers.needsReview.kind).toBe("noul");
    expect(output.answers.needsReview.probability).toBe(0.63);
    expect(task.output.parse(output)).toEqual(output);
    // @ts-expect-error A fixed Noul question cannot return a Choice answer.
    const choice: "choice" = output.answers.needsReview.kind;
    expect(choice).toBe("noul");
  });

  it("reports a typed failure when the task context has no classifier capability", async () => {
    const task = defineClassifierTask({
      id: "classifier-missing-capability",
      input: z.object({}),
      state: () => "example",
      questions: {
        check: { kind: "noul", instructions: "Is this valid?" },
      },
    });

    await expect(
      task.execute({
        input: {},
        signal: new AbortController().signal,
        context: {
          exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          runAgent: async () => undefined,
        },
      }),
    ).rejects.toBeInstanceOf(MissingClassifierCapabilityError);
  });

  it("rejects a result whose answer IDs or kinds drift from the declaration", () => {
    const schema = createClassifierResultSchema({
      review: { kind: "noul", instructions: "Does this need review?" },
      area: {
        kind: "choice",
        instructions: "Which area changed?",
        criteria: { code: "Code", docs: "Documentation" },
      },
      severity: {
        kind: "score",
        instructions: "How severe is the change?",
        criteria: ["Low", "High"],
      },
    });
    const result = {
      model: "jev-1.13.0",
      answers: {
        review: { kind: "noul", probability: 0.5 },
        area: {
          kind: "choice",
          selected: "code",
          probabilities: { code: 0.7, docs: 0.3 },
          confidence: 0.7,
        },
        severity: {
          kind: "score",
          value: 1,
          legend: { "0": "Low", "1": "High" },
          probabilities: { "0": 0.2, "1": 0.8 },
          confidence: 0.8,
        },
      },
      usage: { inputTokens: 4, outputTokens: 2 },
    };

    const parsedResult = schema.parse(result);
    expect(parsedResult).toEqual(result);
    const areaKind: "choice" = parsedResult.answers.area.kind;
    const severityKind: "score" = parsedResult.answers.severity.kind;
    // @ts-expect-error The declared Noul question has a Noul answer.
    const wrongReviewKind: "choice" = parsedResult.answers.review.kind;
    expect([areaKind, severityKind, wrongReviewKind]).toEqual([
      "choice",
      "score",
      "noul",
    ]);
    const wrongKind = schema.safeParse({
      ...result,
      answers: { ...result.answers, review: result.answers.area },
    });
    expect(wrongKind.success).toBe(false);
    if (!wrongKind.success) {
      expect(wrongKind.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ["answers", "review", "kind"] }),
        ]),
      );
    }
    expect(() =>
      schema.parse({ ...result, answers: { review: result.answers.review } }),
    ).toThrow();
    expect(
      schema.safeParse({
        ...result,
        answers: { ...result.answers, extra: result.answers.review },
      }).success,
    ).toBe(false);

    expect(
      schema.safeParse({
        ...result,
        answers: {
          ...result.answers,
          area: { ...result.answers.area, selected: "security" },
        },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...result,
        answers: {
          ...result.answers,
          area: {
            ...result.answers.area,
            probabilities: { code: 0.7005, docs: 0.3 },
          },
        },
      }).success,
    ).toBe(true);
    const invalidNumbers: readonly [
      string,
      keyof typeof result.answers,
      unknown,
    ][] = [
      [
        "Choice NaN probability",
        "area",
        {
          ...result.answers.area,
          probabilities: { code: Number.NaN, docs: 1 },
        },
      ],
      [
        "Choice infinite confidence",
        "area",
        { ...result.answers.area, confidence: Number.POSITIVE_INFINITY },
      ],
      [
        "Score NaN value",
        "severity",
        { ...result.answers.severity, value: Number.NaN },
      ],
      [
        "Noul probability above one",
        "review",
        { ...result.answers.review, probability: 1.01 },
      ],
      [
        "probabilities outside the sum tolerance",
        "area",
        {
          ...result.answers.area,
          probabilities: { code: 0.7011, docs: 0.3 },
        },
      ],
    ];
    for (const [name, id, answer] of invalidNumbers) {
      expect(
        schema.safeParse({
          ...result,
          answers: { ...result.answers, [id]: answer },
        }).success,
        name,
      ).toBe(false);
    }
    expect(
      schema.safeParse({
        ...result,
        answers: {
          ...result.answers,
          area: {
            ...result.answers.area,
            probabilities: { code: 0.7, security: 0.3 },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...result,
        answers: {
          ...result.answers,
          severity: {
            ...result.answers.severity,
            value: 1.1,
          },
        },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...result,
        answers: {
          ...result.answers,
          severity: {
            ...result.answers.severity,
            legend: { "0": "Low", "1": "Severe" },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...result,
        answers: {
          ...result.answers,
          severity: {
            ...result.answers.severity,
            probabilities: { "0": 0.2, "2": 0.8 },
          },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects caller-supplied execution or output contracts", () => {
    const common = {
      id: "invalid-classifier",
      input: z.object({ value: z.string() }),
      state: ({ value }: { readonly value: string }) => value,
      questions: {
        check: { kind: "noul" as const, instructions: "Is this valid?" },
      },
    };
    expect(() =>
      defineClassifierTask({
        ...common,
        execute: async () => ({}),
      } as never),
    ).toThrow("does not accept execute");
    expect(() =>
      defineClassifierTask({ ...common, output: z.unknown() } as never),
    ).toThrow("does not accept output");
  });

  it("defers state validation to the bounded runtime boundary", async () => {
    const input = z.object({ value: z.string() });
    const task = defineClassifierTask({
      id: "classifier-invalid-state",
      input,
      // @ts-expect-error A classifier state root cannot be a number.
      state: () => 42,
      questions: {
        check: { kind: "noul", instructions: "Is this valid?" },
      },
    });

    await expect(
      task.execute({
        input: { value: "example" },
        signal: new AbortController().signal,
        context: {
          exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          runAgent: async () => undefined,
          classify: async (request) => {
            expect(request.state).toBe(42);
            throw new Error("runtime state guard");
          },
        },
      }),
    ).rejects.toThrow("runtime state guard");
  });

  it("validates static questions when the task is defined", () => {
    expect(() =>
      defineClassifierTask({
        id: "classifier-invalid-question",
        input: z.object({}),
        state: () => "example",
        questions: {
          check: { kind: "noul", instructions: "" },
        },
      }),
    ).toThrow();
  });

  it("validates Choice, Score, and Noul criteria boundaries", () => {
    const choiceQuestion = (criteria: Record<string, string>) => ({
      kind: "choice" as const,
      instructions: "Which area?",
      criteria,
    });
    const scoreQuestion = (criteria: string[]) => ({
      kind: "score" as const,
      instructions: "How urgent?",
      criteria,
    });
    expect(
      classifierQuestionsSchema.safeParse({
        area: choiceQuestion({ runtime: "Runtime", docs: "Docs" }),
        priority: scoreQuestion(["Low", "High"]),
      }).success,
    ).toBe(true);
    expect(
      classifierQuestionsSchema.safeParse({
        area: choiceQuestion(
          Object.fromEntries(
            Array.from({ length: 255 }, (_value, index) => [
              `option${index}`,
              `Option ${index}`,
            ]),
          ),
        ),
        priority: scoreQuestion(
          Array.from({ length: 10 }, (_value, index) => `Level ${index}`),
        ),
      }).success,
    ).toBe(true);
    const invalidChoiceCriteria: Record<string, string>[] = [
      { only: "One option" },
      {
        ...Object.fromEntries(
          Array.from({ length: 256 }, (_v, i) => [`o${i}`, `Option ${i}`]),
        ),
      },
      { "": "Runtime", docs: "Docs" },
      { runtime: "", docs: "Docs" },
    ];
    for (const criteria of invalidChoiceCriteria) {
      expect(
        classifierQuestionsSchema.safeParse({
          area: choiceQuestion(criteria),
        }).success,
      ).toBe(false);
    }
    const invalidScoreCriteria: string[][] = [
      ["Only one"],
      Array.from({ length: 11 }, (_value, index) => `Level ${index}`),
      ["Low", "Low"],
    ];
    for (const criteria of invalidScoreCriteria) {
      expect(
        classifierQuestionsSchema.safeParse({
          priority: scoreQuestion(criteria),
        }).success,
      ).toBe(false);
    }
    expect(
      classifierQuestionsSchema.safeParse({
        needsReview: {
          kind: "noul",
          instructions: "Does this need review?",
          criteria: { true: "Yes" },
        },
      }).success,
    ).toBe(false);
  });

  it("selects a new state for each invocation while keeping questions fixed", async () => {
    const input = z.object({ diff: z.string() });
    const task = defineClassifierTask({
      id: "classifier-dynamic-state",
      input,
      state: ({ diff }) => ({ diff }),
      questions: {
        needsReview: {
          kind: "noul",
          instructions: "Does this diff need review?",
        },
      },
    });
    const requests: unknown[] = [];

    for (const diff of ["first diff", "second diff"]) {
      await task.execute({
        input: input.parse({ diff }),
        signal: new AbortController().signal,
        context: {
          exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          runAgent: async () => undefined,
          classify: async (request) => {
            requests.push(request);
            return {
              model: "jev-1.13.0",
              answers: { needsReview: { kind: "noul", probability: 0.5 } },
              usage: { inputTokens: 4, outputTokens: 1 },
            };
          },
        },
      });
    }

    expect(requests).toEqual([
      {
        state: { diff: "first diff" },
        questions: {
          needsReview: {
            kind: "noul",
            instructions: "Does this diff need review?",
          },
        },
      },
      {
        state: { diff: "second diff" },
        questions: {
          needsReview: {
            kind: "noul",
            instructions: "Does this diff need review?",
          },
        },
      },
    ]);
  });

  it("snapshots static questions when the task is defined", async () => {
    const questions = {
      check: {
        kind: "noul" as const,
        instructions: "Is this valid?",
      },
    };
    const task = defineClassifierTask({
      id: "classifier-question-snapshot",
      input: z.object({}),
      state: () => "example",
      questions,
    });
    questions.check.instructions = "Changed after task definition";

    await task.execute({
      input: {},
      signal: new AbortController().signal,
      context: {
        exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        runAgent: async () => undefined,
        classify: async (request) => {
          expect(request.questions.check).toEqual({
            kind: "noul",
            instructions: "Is this valid?",
          });
          return {
            model: "jev-1.13.0",
            answers: { check: { kind: "noul", probability: 0.5 } },
            usage: { inputTokens: 4, outputTokens: 1 },
          };
        },
      },
    });
  });
});
