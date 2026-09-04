// @test-scope ./operational-client.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OperationalClient,
  OperationalClientError,
} from "./operational-client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OperationalClient", () => {
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
    expect(fetchMock).toHaveBeenLastCalledWith(
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
        new Response(
          JSON.stringify({
            "repository:other": { id: "other" },
            "user:fixture": { id: "fixture" },
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
