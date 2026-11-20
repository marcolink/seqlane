// @test-scope ./schemas.ts
import { describe, expect, it } from "vitest";
import { questionFormSchema } from "./schemas.js";
import { translateQuestionForm } from "./questions.js";

const field = {
  key: "q0",
  title: "Region",
  description: "Where must the task run?",
  type: "string",
  custom: true,
  options: [{ label: "Europe", value: "not a canonical ID / Europe" }],
};
function form(fields: unknown = [field]) {
  return {
    id: "form_native",
    sessionID: "ses_owned",
    title: "Questions",
    metadata: { kind: "question" },
    fields,
  };
}
const translate = (raw: unknown) =>
  translateQuestionForm(questionFormSchema.parse(raw), (text) => text);

describe("native question translation", () => {
  it("maps single-choice IDs to native values and preserves custom text", () => {
    const translated = translate(form());
    expect(translated.request).toEqual({
      questions: [
        {
          id: "question_0",
          prompt: "Region\nWhere must the task run?",
          allowFreeText: true,
          options: [{ label: "Europe", value: "option_0" }],
        },
      ],
    });
    expect(
      translated.answer({
        status: "answered",
        answers: { question_0: "option_0" },
      }),
    ).toEqual({ q0: field.options[0]!.value });
    expect(
      translated.answer({
        status: "answered",
        answers: { question_0: "somewhere else" },
      }),
    ).toEqual({ q0: "somewhere else" });
  });
  it("supports text-only questions with absent or empty native options", () => {
    for (const options of [undefined, []]) {
      const translated = translate(form([{ ...field, options }]));
      expect(translated.request.questions[0]).toMatchObject({
        allowFreeText: true,
      });
      expect(translated.request.questions[0]?.options).toBeUndefined();
      expect(
        translated.answer({
          status: "answered",
          answers: { question_0: "Ada" },
        }),
      ).toEqual({ q0: "Ada" });
    }
  });
  it("accepts eight questions and twenty choices within canonical bounds", () => {
    const translated = translate(
      form(
        Array.from({ length: 8 }, (_, index) => ({
          ...field,
          key: `q${index}`,
          options: Array.from({ length: 20 }, (_, option) => ({
            label: `Choice ${option}`,
            value: `value ${option}`,
          })),
        })),
      ),
    );
    expect(translated.request.questions).toHaveLength(8);
    expect(translated.request.questions[0]?.options).toHaveLength(20);
  });
  it("rejects a complete request above the canonical byte limit", () => {
    const fields = Array.from({ length: 8 }, (_, index) => ({
      ...field,
      key: `q${index}`,
      title: "a".repeat(4096),
      description: undefined,
      options: Array.from({ length: 20 }, (_, option) => ({
        label: "b".repeat(256),
        value: `value ${option}`,
      })),
    }));
    expect(() => translate(form(fields))).toThrow("64 KiB");
  });
  it.each([
    { ...field, required: false },
    { ...field, type: "multiselect" },
    { ...field, type: "number" },
    { ...field, key: "__proto__" },
    { ...field, key: "q1" },
    {
      ...field,
      options: [
        { label: "A", value: "same" },
        { label: "B", value: "same" },
      ],
    },
    { ...field, options: [{ label: "A", value: 7 }] },
    { ...field, options: [], custom: false },
    {
      ...field,
      options: Array.from({ length: 21 }, (_, index) => ({
        label: "A",
        value: `${index}`,
      })),
    },
  ])("rejects malformed or unsupported fields: %j", (invalid) => {
    expect(() => translate(form([invalid]))).toThrow();
  });
  it.each([
    "when",
    "hidden",
    "default",
    "format",
    "pattern",
    "minLength",
    "maxLength",
    "placeholder",
    "minimum",
    "maximum",
    "minItems",
    "maxItems",
  ])("rejects unsupported constraint %s", (constraint) => {
    expect(() => translate(form([{ ...field, [constraint]: true }]))).toThrow();
  });
  it.each([
    { ...form(), metadata: { kind: "permission" } },
    { ...form(), metadata: undefined },
    { ...form(), sessionID: "" },
    { ...form(), id: 1 },
    form([]),
    form([field, field]),
    form(
      Array.from({ length: 9 }, (_, index) => ({ ...field, key: `q${index}` })),
    ),
    form([{ ...field, title: "a".repeat(4096) }]),
    form([
      {
        ...field,
        options: [{ label: "a".repeat(256), value: "a", description: "b" }],
      },
    ]),
  ])("rejects malformed, arbitrary, or over-bound forms", (invalid) => {
    expect(() => translate(invalid)).toThrow();
  });
  it.each([
    undefined,
    { status: "cancelled" },
    { status: "answered", answers: {} },
    { status: "answered", answers: { question_0: "" } },
    { status: "answered", answers: { question_0: "   " } },
    { status: "answered", answers: { question_0: ["option_0"] } },
    { status: "answered", answers: { question_0: "a".repeat(8193) } },
    { status: "answered", answers: { question_0: "option_0", extra: "x" } },
  ])("rejects malformed answers: %j", (answer) => {
    expect(() => translate(form()).answer(answer)).toThrow();
  });
  it("rejects custom answers for closed single-choice questions", () => {
    const translated = translate(form([{ ...field, custom: false }]));
    expect(translated.request.questions[0]?.allowFreeText).toBe(false);
    expect(() =>
      translated.answer({
        status: "answered",
        answers: { question_0: "custom" },
      }),
    ).toThrow();
    expect(
      translated.answer({
        status: "answered",
        answers: { question_0: "option_0" },
      }),
    ).toEqual({ q0: field.options[0]!.value });
  });
});
