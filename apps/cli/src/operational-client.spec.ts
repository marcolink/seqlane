// @test-scope ./operational-client.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OperationalClient,
  OperationalClientError,
} from "./operational-client.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const workflow = {
  id: "fixture",
  key: "repository:fixture",
  input: { schema: {} },
  output: { schema: {} },
  plan: { workflow: { id: "fixture" }, nodes: [] },
};

const runStatus = (status: string, output?: unknown) => ({
  version: 1,
  workId: "work-1",
  runId: "run-1",
  workflowKey: "repository:fixture",
  status,
  createdAt: "2026-10-22T10:00:00.000Z",
  updatedAt: "2026-10-22T10:00:01.000Z",
  ...(output === undefined ? {} : { output }),
  completeness: {
    inspection:
      status === "queued" || status === "running" ? "incomplete" : "complete",
  },
});

function stubJsonFetch(
  handler: (url: URL, request: Request) => Response | Promise<Response>,
) {
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    return handler(new URL(request.url), request);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("OperationalClient", () => {
  it("posts v1 identities and observes a long healthy run until its normalized result is ready", async () => {
    vi.useFakeTimers();
    let statusPolls = 0;
    const fetchMock = stubJsonFetch((url) => {
      if (url.pathname === "/api/workflows") {
        return Response.json({ version: 1, workflows: [workflow] });
      }
      if (url.pathname.endsWith("/start-async")) {
        return Response.json({
          version: 1,
          workId: "work-1",
          runId: "run-1",
          status: "queued",
        });
      }
      if (url.pathname.endsWith("/runs/run-1")) {
        statusPolls += 1;
        if (statusPolls === 8 || statusPolls === 20) {
          return Response.json({ message: "not found" }, { status: 404 });
        }
        return Response.json(
          statusPolls <= 45
            ? runStatus("running")
            : runStatus("succeeded", { ok: true }),
        );
      }
      return new Response(null, { status: 404 });
    });

    const result = new OperationalClient("http://127.0.0.1:4111/").startRun({
      workflowId: "fixture",
      runId: "run-1",
      workId: "work-1",
      input: { value: false },
      runtimeId: "local",
      workspace: "/tmp/workspace",
    });
    await vi.runAllTimersAsync();
    await expect(result).resolves.toMatchObject({
      status: "succeeded",
      output: { ok: true },
      completeness: { inspection: "complete" },
    });
    expect(statusPolls).toBe(46);
    const startRequest = fetchMock.mock.calls.find(([input]) =>
      String(input).includes("start-async"),
    )?.[1];
    expect(startRequest?.redirect).toBe("error");
    expect(JSON.parse(String(startRequest?.body))).toEqual({
      version: 1,
      workId: "work-1",
      runId: "run-1",
      input: { value: false },
      runtime: { id: "local", workspace: "/tmp/workspace" },
    });
  });

  it("fails after twelve consecutive unavailable observations", async () => {
    vi.useFakeTimers();
    const fetchMock = stubJsonFetch((url) => {
      if (url.pathname === "/api/workflows") {
        return Response.json({ version: 1, workflows: [workflow] });
      }
      if (url.pathname.endsWith("/start-async")) {
        return Response.json({
          version: 1,
          workId: "work-1",
          runId: "run-1",
          status: "queued",
        });
      }
      return Response.json({ message: "not found" }, { status: 404 });
    });

    const result = new OperationalClient("http://localhost:4111").startRun({
      workflowId: "fixture",
      runId: "run-1",
      workId: "work-1",
      input: {},
    });
    const rejection = expect(result).rejects.toMatchObject({
      status: 404,
      message:
        'Operational run "run-1" remained unavailable after 12 observations',
    });
    await vi.runAllTimersAsync();
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(14);
  });

  it("validates response DTOs and preserves the schema error as cause", async () => {
    stubJsonFetch(() =>
      Response.json({ version: 1, workflows: [{ key: "bad" }] }),
    );

    await expect(
      new OperationalClient("http://localhost:4111").listWorkflows(),
    ).rejects.toMatchObject({
      name: "OperationalClientError",
      message: "Operational server returned an invalid response",
      cause: expect.objectContaining({ name: "ZodError" }),
    });
  });

  it("rejects an oversized streamed response before JSON decoding", async () => {
    const cancelReader = vi.fn();
    stubJsonFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(32 * 1024 * 1024 + 1));
            },
            cancel: cancelReader,
          }),
        ),
    );

    await expect(
      new OperationalClient("http://localhost:4111").health(),
    ).rejects.toMatchObject({
      name: "OperationalClientError",
      message: "Operational server response is too large",
      status: 200,
    });
    expect(cancelReader).toHaveBeenCalledOnce();
  });

  it("interrupts a body that stalls after response headers at the request deadline", async () => {
    vi.useFakeTimers();
    stubJsonFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              return new Promise<void>(() => undefined);
            },
          }),
        ),
    );

    const pending = new OperationalClient("http://localhost:4111").health();
    const rejection = expect(pending).rejects.toMatchObject({
      name: "OperationalClientError",
      message: "Operational server request timed out",
      timedOut: true,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
  });

  it("rejects redirects without requesting the destination", async () => {
    const fetchMock = stubJsonFetch(() =>
      Response.redirect("http://example.com/private"),
    );

    await expect(
      new OperationalClient("http://localhost:4111").health(),
    ).rejects.toBeInstanceOf(OperationalClientError);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("error");
  });

  it("uses the v1 cancel DTO and exposes status and cancellation state", async () => {
    const fetchMock = stubJsonFetch(async (url, request) => {
      if (url.pathname === "/api/workflows") {
        return Response.json({ version: 1, workflows: [workflow] });
      }
      if (url.pathname.endsWith("/cancel")) {
        await expect(request.clone().json()).resolves.toEqual({
          version: 1,
          runId: "run-1",
        });
        return Response.json({
          version: 1,
          runId: "run-1",
          status: "cancelled",
          cancellationRequested: true,
        });
      }
      return new Response(null, { status: 404 });
    });

    await expect(
      new OperationalClient("http://localhost:4111").cancelRun(
        "run-1",
        "fixture",
      ),
    ).resolves.toEqual({
      version: 1,
      runId: "run-1",
      status: "cancelled",
      cancellationRequested: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reads health, readiness, workflow, run, event, and trace DTOs", async () => {
    stubJsonFetch((url) => {
      if (url.pathname === "/healthz") {
        return Response.json({ version: 1, status: "ok" });
      }
      if (url.pathname === "/readyz") {
        return Response.json({ version: 1, status: "ready", checks: [] });
      }
      if (url.pathname === "/api/workflows/repository%3Afixture") {
        return Response.json({ version: 1, workflow });
      }
      if (url.pathname === "/api/runs") {
        return Response.json({ version: 1, runs: [] });
      }
      if (url.pathname === "/api/runs/run-1/events") {
        return Response.json({
          version: 1,
          runId: "run-1",
          afterSequence: 0,
          events: [],
          nextSequence: 0,
          status: "running",
          completeness: { inspection: "incomplete" },
        });
      }
      if (url.pathname === "/api/runs/run-1/trace") {
        return Response.json({
          version: 1,
          runId: "run-1",
          spans: [],
          droppedRecords: 0,
          completeness: { inspection: "complete" },
        });
      }
      if (url.pathname === "/api/runs/run-1") {
        return Response.json(runStatus("running"));
      }
      return new Response(null, { status: 404 });
    });
    const client = new OperationalClient("http://localhost:4111");

    await expect(client.health()).resolves.toEqual({
      version: 1,
      status: "ok",
    });
    await expect(client.readiness()).resolves.toEqual({
      version: 1,
      status: "ready",
      checks: [],
    });
    await expect(client.getWorkflow("repository:fixture")).resolves.toEqual(
      workflow,
    );
    await expect(client.getRun("run-1")).resolves.toMatchObject({
      status: "running",
    });
    await expect(client.listRuns()).resolves.toEqual({ version: 1, runs: [] });
    await expect(client.getRunEvents("run-1")).resolves.toMatchObject({
      events: [],
      status: "running",
    });
    await expect(client.getTrace("run-1")).resolves.toMatchObject({
      runId: "run-1",
      spans: [],
    });
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

  it("retains abort errors and cancels an in-flight request", async () => {
    const controller = new AbortController();
    const fetchMock = stubJsonFetch(
      (_url, request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const pending = new OperationalClient("http://localhost:4111").health(
      controller.signal,
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const reason = new Error("stop observation");
    controller.abort(reason);
    await expect(pending).rejects.toMatchObject({
      message: "Operational run observation was aborted",
      cause: reason,
    });
  });
});
