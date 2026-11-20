// @test-scope ./schemas.ts
// @test-scope ./client.ts
import { once } from "node:events";
import { createServer } from "node:http";
import { defineTask, InteractionRequiredError } from "@seqlane/core";
import type { AgentAdapterRequest } from "@seqlane/agent-adapter";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createClient } from "./client.js";
import { questionFormSchema } from "./schemas.js";
import { createQuestionMonitor, translateQuestionForm } from "./questions.js";

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

async function monitorFixture(sessionIDs = ["ses_first", "ses_last"]) {
  const forms = new Map<string, unknown[]>();
  const details = new Map<string, unknown>();
  const permissions = new Set<string>();
  const effects: string[] = [];
  for (const sessionID of sessionIDs) {
    const native = { ...form(), id: `form_${sessionID}`, sessionID };
    forms.set(sessionID, [native]);
    details.set(sessionID, { ...native, state: { status: "pending" } });
  }
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture").pathname;
    const sessionID = path.split("/")[3] ?? "";
    response.setHeader("content-type", "application/json");
    if (path.endsWith("/permission")) {
      response.end(
        JSON.stringify({
          data: permissions.has(sessionID) ? [{ id: "permission" }] : [],
        }),
      );
    } else if (path.endsWith("/reply")) {
      effects.push(`reply:${sessionID}`);
      response.writeHead(204);
      response.end();
    } else if (request.method === "DELETE") {
      effects.push(`cancel:${sessionID}`);
      response.writeHead(204);
      response.end();
    } else if (path.endsWith("/form")) {
      response.end(JSON.stringify({ data: forms.get(sessionID) ?? [] }));
    } else {
      effects.push(`detail:${sessionID}`);
      response.end(JSON.stringify({ data: details.get(sessionID) }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Fixture listener has no port");
  const callback = vi.fn(async () => {
    effects.push("callback");
    return { status: "answered" as const, answers: { question_0: "Ada" } };
  });
  const request: AgentAdapterRequest = {
    invocationId: "question-preflight",
    task: defineTask({
      id: "question-preflight",
      input: z.object({}),
      output: z.object({}),
      execute: async () => ({}),
    }),
    input: {},
    agent: { goal: "Answer questions", instructions: [] },
    signal: AbortSignal.timeout(5_000),
    onExecutionStarted: vi.fn(),
    requestUserInput: callback,
  };
  return {
    forms,
    details,
    permissions,
    effects,
    callback,
    monitor: createQuestionMonitor(
      createClient(`http://127.0.0.1:${address.port}`),
      request,
      (text) => text,
    ),
    sessions: new Set(sessionIDs),
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

describe("native question preflight", () => {
  it.each([
    "list-owner",
    "list-fields",
    "detail-owner",
    "detail-fields",
    "detail-size",
  ])("rejects a later %s before earlier callbacks or replies", async (mode) => {
    const h = await monitorFixture();
    try {
      const native = {
        ...form(),
        id: "form_ses_last",
        sessionID: "ses_last",
      };
      if (mode === "list-owner")
        h.forms.set("ses_last", [{ ...native, sessionID: "ses_foreign" }]);
      if (mode === "list-fields")
        h.forms.set("ses_last", [{ ...native, fields: [] }]);
      if (mode === "detail-owner")
        h.details.set("ses_last", {
          ...native,
          sessionID: "ses_foreign",
          state: { status: "pending" },
        });
      if (mode === "detail-fields")
        h.details.set("ses_last", {
          ...native,
          fields: [],
          state: { status: "pending" },
        });
      if (mode === "detail-size")
        h.details.set("ses_last", {
          ...native,
          fields: Array.from({ length: 8 }, (_, index) => ({
            ...field,
            key: `q${index}`,
            title: "a".repeat(4096),
            description: undefined,
            options: Array.from({ length: 20 }, (_, option) => ({
              label: "b".repeat(256),
              value: `value ${option}`,
            })),
          })),
          state: { status: "pending" },
        });
      await expect(h.monitor(h.sessions)).rejects.toThrow();
      expect(h.callback).not.toHaveBeenCalled();
      expect(h.effects.some((effect) => effect.startsWith("reply:"))).toBe(
        false,
      );
    } finally {
      await h.close();
    }
  });
  it("rejects a permission in a later enumeration batch before callbacks or replies", async () => {
    const sessions = Array.from({ length: 17 }, (_, index) => `ses_${index}`);
    const h = await monitorFixture(sessions);
    try {
      h.permissions.add("ses_16");
      await expect(h.monitor(h.sessions)).rejects.toBeInstanceOf(
        InteractionRequiredError,
      );
      expect(h.callback).not.toHaveBeenCalled();
      expect(h.effects.some((effect) => effect.startsWith("reply:"))).toBe(
        false,
      );
    } finally {
      await h.close();
    }
  });
  it("rejects a form ID shared by different sessions before callbacks or replies", async () => {
    const h = await monitorFixture();
    try {
      h.forms.set("ses_last", [
        { ...form(), id: "form_ses_first", sessionID: "ses_last" },
      ]);
      await expect(h.monitor(h.sessions)).rejects.toThrow("different owner");
      expect(h.callback).not.toHaveBeenCalled();
      expect(h.effects.some((effect) => effect.startsWith("reply:"))).toBe(
        false,
      );
    } finally {
      await h.close();
    }
  });
  it("bounds the aggregate pending set before detail reads or callbacks", async () => {
    const h = await monitorFixture();
    try {
      for (const [sessionID, count] of [
        ["ses_first", 600],
        ["ses_last", 425],
      ] as const)
        h.forms.set(
          sessionID,
          Array.from({ length: count }, (_, index) => ({
            ...form(),
            id: `form_${sessionID}_${index}`,
            sessionID,
          })),
        );
      await expect(h.monitor(h.sessions)).rejects.toThrow();
      expect(h.callback).not.toHaveBeenCalled();
      expect(h.effects).toEqual([]);
    } finally {
      await h.close();
    }
  });
  it("reads all form details before callbacks and replies for a valid tree", async () => {
    const h = await monitorFixture();
    try {
      await h.monitor(h.sessions);
      expect(h.effects).toEqual([
        "detail:ses_first",
        "detail:ses_last",
        "callback",
        "reply:ses_first",
        "callback",
        "reply:ses_last",
      ]);
      await h.monitor(h.sessions);
      expect(h.callback).toHaveBeenCalledTimes(2);
    } finally {
      await h.close();
    }
  });
});
