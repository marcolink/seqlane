// @test-scope ./client.ts
// @test-scope ./live-events.ts
import type { AgentAdapterRequest } from "@seqlane/agent-adapter";
import { defineTask, InteractionRequiredError } from "@seqlane/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createClient } from "./client.js";
import { waitForResult } from "./completion.js";

const workspace = "/fixture";
const model = { providerID: "fixture", id: "fixture", variant: "high" };
const task = defineTask({
  id: "completion-test",
  input: z.object({}),
  output: z.object({ answer: z.string() }),
  execute: async () => ({ answer: "local" }),
});
const encoder = new TextEncoder();

function fixture() {
  const calls: string[] = [];
  const state = {
    terminal: false,
    changedModel: false,
    permission: false,
    form: false,
    reads: 0,
    children: ["child_left", "child_right"],
  };
  const controller = new AbortController();
  let events: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      events = value;
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const path = url.pathname;
      calls.push(path);
      const json = (value: unknown) => Response.json(value);
      if (path === "/api/event") {
        init?.signal?.addEventListener(
          "abort",
          () => events?.error(init.signal?.reason),
          { once: true },
        );
        return new Response(body, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (path === "/api/session/active") return json({ data: {} });
      if (path === "/api/shell") return json({ data: [] });
      if (path === "/api/session") {
        const children =
          url.searchParams.get("parentID") === "owned" ? state.children : [];
        return json({
          data: children.map((id) => ({
            id,
            parentID: "owned",
            location: { directory: workspace },
          })),
          cursor: {},
        });
      }
      if (path.endsWith("/permission"))
        return json({ data: state.permission ? [{ id: "permission" }] : [] });
      if (path.endsWith("/form"))
        return json({ data: state.form ? [{ id: "form" }] : [] });
      if (path.endsWith("/message")) {
        state.reads++;
        return json({
          data: [
            ...(state.terminal
              ? [{ id: "idle", type: "idle", outcome: "succeeded" }]
              : []),
            {
              id: "assistant",
              type: "assistant",
              model: {
                ...model,
                id: state.changedModel ? "changed" : model.id,
              },
              time: { created: 1, ...(state.terminal ? { completed: 2 } : {}) },
              content: [{ type: "text", text: '{"answer":"ok"}' }],
            },
            { id: "input", type: "user" },
          ],
          cursor: {},
        });
      }
      return json({
        data: {
          id: path.split("/").at(-1),
          location: { directory: workspace },
        },
      });
    }),
  );
  const request: AgentAdapterRequest = {
    invocationId: "completion-test",
    task,
    input: {},
    agent: { goal: "Return an answer" },
    signal: controller.signal,
    onExecutionStarted: vi.fn(),
  };
  return {
    calls,
    state,
    controller,
    count(path: string) {
      return calls.filter((call) => call === path).length;
    },
    emit(
      index: number,
      type = "session.message.content.updated",
      data: unknown = { sessionID: "owned" },
    ) {
      events?.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ id: `event_${index}`, type, data })}\n\n`,
        ),
      );
    },
    run() {
      return waitForResult(
        createClient("http://fixture"),
        workspace,
        (text) => text,
        request,
        "owned",
        "input",
        model,
      );
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("completion with scoped live reads", () => {
  it.each(["permission.created", "form.created", "session.created"])(
    "reconciles the owned tree and pending interactions after %s",
    async (type) => {
      const h = fixture();
      const pending = h.run().catch((cause: unknown) => cause);
      try {
        await vi.waitFor(() => expect(h.state.reads).toBe(1));
        if (type === "form.created") h.state.form = true;
        else h.state.permission = true;
        if (type === "session.created") h.state.children.push("new_child");
        const data =
          type === "form.created"
            ? { form: { sessionID: "owned" } }
            : type === "session.created"
              ? { sessionID: "new_child", parentID: "owned" }
              : { sessionID: "owned" };
        h.emit(1, type, data);
        await vi.waitFor(
          () => expect(h.count("/api/session/owned/permission")).toBe(2),
          { timeout: 400 },
        );
        expect(await pending).toBeInstanceOf(InteractionRequiredError);
        expect(h.count("/api/session/owned/form")).toBe(2);
        if (type === "session.created") {
          expect(h.count("/api/session/new_child")).toBe(1);
          expect(h.count("/api/session/new_child/permission")).toBe(1);
          expect(h.count("/api/session/new_child/form")).toBe(1);
        }
      } finally {
        h.controller.abort();
        await pending;
      }
    },
  );

  it("bounds ownership, permission, and form requests while recovering under a message flood", async () => {
    const h = fixture();
    const pending = h.run();
    let eventID = 0;
    const flood = setInterval(() => h.emit(eventID++), 10);
    try {
      await vi.waitFor(() => expect(h.state.reads).toBeGreaterThanOrEqual(3));
      expect(h.count("/api/session")).toBe(3);
      for (const id of ["owned", ...h.state.children]) {
        expect(h.count(`/api/session/${id}`)).toBe(1);
        expect(h.count(`/api/session/${id}/permission`)).toBe(1);
        expect(h.count(`/api/session/${id}/form`)).toBe(1);
      }
      h.state.terminal = true;
      await expect(pending).resolves.toEqual({ answer: "ok" });
      expect(h.state.reads).toBe(4);
      expect(h.count("/api/session")).toBe(6);
      for (const id of ["owned", ...h.state.children]) {
        expect(h.count(`/api/session/${id}`)).toBe(2);
        expect(h.count(`/api/session/${id}/permission`)).toBe(2);
        expect(h.count(`/api/session/${id}/form`)).toBe(2);
      }
      expect(h.count("/api/session/active")).toBe(1);
      expect(h.count("/api/shell")).toBe(1);
    } finally {
      clearInterval(flood);
      h.controller.abort();
      await pending.catch(() => undefined);
    }
  });

  it("keeps a terminal message snapshot pending until full permission checks", async () => {
    const h = fixture();
    let settled = false;
    const pending = h.run().then(
      (value) => {
        settled = true;
        return { value };
      },
      (cause: unknown) => {
        settled = true;
        return { cause };
      },
    );
    try {
      await vi.waitFor(() => expect(h.state.reads).toBe(1));
      h.state.terminal = true;
      h.emit(1);
      await vi.waitFor(() => expect(h.state.reads).toBe(2), { timeout: 400 });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(settled).toBe(false);
      expect(h.count("/api/session/active")).toBe(0);
      h.state.permission = true;
      expect(await pending).toEqual({
        cause: expect.any(InteractionRequiredError),
      });
    } finally {
      h.controller.abort();
      await pending;
    }
  });

  it("checks the selected assistant model during message-only reads", async () => {
    const h = fixture();
    const pending = h.run().catch((cause: unknown) => cause);
    try {
      await vi.waitFor(() => expect(h.state.reads).toBe(1));
      h.state.changedModel = true;
      h.emit(1);
      expect(await pending).toMatchObject({
        code: "protocol",
        message: "OpenCode V2: native assistant changed the selected model",
      });
      expect(h.count("/api/session")).toBe(3);
    } finally {
      h.controller.abort();
      await pending;
    }
  });
});
