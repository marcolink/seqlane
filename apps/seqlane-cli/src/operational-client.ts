import { z } from "zod";

const workflowListSchema = z.record(
  z.string(),
  z.object({ id: z.string().optional() }).passthrough(),
);

const controlResponseSchema = z.object({ message: z.string() }).passthrough();

const runResponseSchema = z
  .object({
    runId: z.string().min(1),
    workflowName: z.string().min(1).optional(),
    status: z.string().min(1),
    resourceId: z.string().min(1).optional(),
    result: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .passthrough();

const startResponseSchema = z
  .object({
    status: z.string().min(1),
    result: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .passthrough();

export type OperationalRun = z.output<typeof runResponseSchema>;
export type OperationalStartResult = z.output<typeof startResponseSchema>;

export class OperationalClientError extends Error {
  readonly status: number | undefined;

  constructor(
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "OperationalClientError";
    this.status = options.status;
  }
}

function baseUrl(value: string): string {
  try {
    return new URL(value).toString().replace(/\/$/, "");
  } catch (cause) {
    throw new OperationalClientError("Operational server URL is invalid", {
      cause,
    });
  }
}

function responseError(status: number, body: unknown): OperationalClientError {
  const message =
    typeof body === "object" &&
    body !== null &&
    "message" in body &&
    typeof body.message === "string"
      ? body.message
      : `Operational server request failed with HTTP ${status}`;
  return new OperationalClientError(message, { status });
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch (cause) {
    throw new OperationalClientError(
      "Operational server returned invalid JSON",
      {
        status: response.status,
        cause,
      },
    );
  }
}

export class OperationalClient {
  readonly origin: string;

  constructor(origin: string) {
    this.origin = baseUrl(origin);
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    schema: z.ZodType<T>,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.origin}${path}`, init);
    } catch (cause) {
      throw new OperationalClientError("Could not reach operational server", {
        cause,
      });
    }
    const body = await readBody(response);
    if (!response.ok) throw responseError(response.status, body);
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new OperationalClientError(
        "Operational server returned an invalid response",
        { status: response.status, cause: parsed.error },
      );
    }
    return parsed.data;
  }

  async listWorkflows(): Promise<readonly string[]> {
    const workflows = await this.request(
      "/api/workflows",
      { method: "GET" },
      workflowListSchema,
    );
    return Object.keys(workflows).sort();
  }

  async resolveWorkflow(workflowId: string): Promise<string> {
    const workflows = await this.request(
      "/api/workflows",
      { method: "GET" },
      workflowListSchema,
    );
    if (workflows[workflowId] !== undefined) return workflowId;
    const match = Object.entries(workflows).find(
      ([, workflow]) => workflow.id === workflowId,
    );
    if (match !== undefined) return match[0];
    throw new OperationalClientError(
      `Workflow "${workflowId}" is not registered with the operational server`,
      { status: 404 },
    );
  }

  async startRun(options: {
    readonly workflowId: string;
    readonly runId: string;
    readonly workId: string;
    readonly input: unknown;
    readonly runtimeId?: string;
    readonly workspace?: string;
  }): Promise<OperationalStartResult> {
    const workflowId = encodeURIComponent(
      await this.resolveWorkflow(options.workflowId),
    );
    const query = new URLSearchParams({ runId: options.runId });
    return this.request(
      `/api/workflows/${workflowId}/start-async?${query.toString()}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resourceId: options.workId,
          inputData: options.input,
          requestContext: {
            "seqlane.workId": options.workId,
            "seqlane.runId": options.runId,
            ...(options.runtimeId === undefined
              ? {}
              : { "seqlane.runtimeId": options.runtimeId }),
            ...(options.workspace === undefined
              ? {}
              : { "seqlane.workspace": options.workspace }),
          },
          tracingOptions: {
            metadata: {
              "seqlane.workId": options.workId,
              "seqlane.runId": options.runId,
            },
            traceId: options.runId
              .replaceAll("-", "")
              .padEnd(32, "0")
              .slice(0, 32),
          },
        }),
      },
      startResponseSchema,
    );
  }

  async getRun(runId: string, workflowId?: string): Promise<OperationalRun> {
    const candidates = workflowId
      ? [await this.resolveWorkflow(workflowId)]
      : await this.listWorkflows();
    let lastNotFound: OperationalClientError | undefined;
    for (const candidate of candidates) {
      const encodedWorkflow = encodeURIComponent(candidate);
      try {
        return await this.request(
          `/api/workflows/${encodedWorkflow}/runs/${encodeURIComponent(runId)}`,
          { method: "GET" },
          runResponseSchema,
        );
      } catch (error) {
        if (error instanceof OperationalClientError && error.status === 404) {
          lastNotFound = error;
          continue;
        }
        throw error;
      }
    }
    throw (
      lastNotFound ??
      new OperationalClientError(`Run "${runId}" was not found`, {
        status: 404,
      })
    );
  }

  async cancelRun(runId: string, workflowId?: string): Promise<string> {
    const run = await this.getRun(runId, workflowId);
    const resolvedWorkflow = workflowId ?? run.workflowName;
    if (resolvedWorkflow === undefined) {
      throw new OperationalClientError(
        `Run "${runId}" does not identify a workflow`,
      );
    }
    const workflow = encodeURIComponent(
      await this.resolveWorkflow(resolvedWorkflow),
    );
    const response = await this.request(
      `/api/workflows/${workflow}/runs/${encodeURIComponent(runId)}/cancel`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
      controlResponseSchema,
    );
    return response.message;
  }
}
