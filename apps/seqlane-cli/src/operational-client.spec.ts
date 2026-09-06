// @test-scope ./operational-client.ts
// @test-scope ../../../libs/seqlane-runtime/src/runtime/mastra/operational-host.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Plan, PlanNode } from "@seqlane/core";
import {
  createOperationalHost,
  createOperationalWorkflow,
} from "@seqlane/runtime/operational-host";
import { z } from "zod";
import {
  OperationalClient,
  OperationalClientError,
} from "./operational-client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OperationalClient", () => {
  it("starts and observes a run through the real Mastra operational routes", async () => {
    const node: PlanNode = {
      type: "task",
      taskId: "fixture.task",
      nodeId: "fixture.task:1",
      input: {},
      dependsOn: [],
      execution: "local",
      workspace: "exclusive",
    };
    const plan: Plan = {
      workflow: { id: "fixture-workflow" },
      nodes: [node],
      output: { type: "ref", nodeId: node.nodeId, path: ["output"] },
    };
    const host = await createOperationalHost({
      workflows: [
        createOperationalWorkflow({
          key: "repository:fixture",
          plan,
          taskDefinitions: new Map([
            [
              "fixture.task",
              {
                id: "fixture.task",
                input: z.object({}),
                output: z.object({ ok: z.boolean() }),
                execute: async () => ({ ok: true }),
              },
            ],
          ]),
        }),
      ],
      storageUrl: "file::memory:",
    });
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      host.fetch(new Request(input, init)),
    );

    try {
      await expect(
        new OperationalClient("http://127.0.0.1:4111").startRun({
          workflowId: "repository:fixture",
          runId: "run-real-route",
          workId: "work-real-route",
          input: {},
          runtimeId: "local",
        }),
      ).resolves.toMatchObject({ status: "success", result: { ok: true } });
    } finally {
      await host.close();
    }
  });

  it("validates workflow registration and starts a run through Mastra routes", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ "repository:fixture": { id: "fixture" } }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ status: "success", result: { ok: true } }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            runId: "run-1",
            workflowName: "repository:fixture",
            status: "success",
            result: { ok: true },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await new OperationalClient(
      "http://127.0.0.1:4111/",
    ).startRun({
      workflowId: "repository:fixture",
      runId: "run-1",
      workId: "work-1",
      input: { value: 1 },
      runtimeId: "local",
    });

    expect(result).toEqual({ status: "success", result: { ok: true } });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4111/api/workflows/repository%3Afixture/start-async?runId=run-1",
      expect.objectContaining({ method: "POST" }),
    );
    const init = fetchMock.mock.calls[1]?.[1];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      resourceId: "work-1",
      inputData: { value: 1 },
      requestContext: {
        "seqlane.workId": "work-1",
        "seqlane.runId": "run-1",
      },
    });
  });

  it("finds a run by ID across registered workflows and cancels it idempotently", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            "repository:other": { id: "other" },
            "user:fixture": { id: "fixture" },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "not found" }), { status: 404 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            runId: "run-1",
            workflowName: "fixture",
            status: "running",
            resourceId: "work-1",
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "Workflow run cancelled" })),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new OperationalClient("http://localhost:4111").cancelRun("run-1"),
    ).resolves.toBe("Workflow run cancelled");
    expect(fetchMock).toHaveBeenLastCalledWith(
      "http://localhost:4111/api/workflows/user%3Afixture/runs/run-1/cancel",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each([
    "https://localhost:4111",
    "http://example.com:4111",
    "http://user:password@127.0.0.1:4111",
  ])("rejects unsafe operational server URL %s", (origin) => {
    expect(() => new OperationalClient(origin)).toThrow(
      "Operational server URL is invalid",
    );
  });

  it("rejects malformed server responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify({ bad: true }))),
    );

    await expect(
      new OperationalClient("http://localhost:4111").listWorkflows(),
    ).rejects.toBeInstanceOf(OperationalClientError);
  });
});
