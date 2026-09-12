import { MCPServer } from "@mastra/mcp";
import { createTool } from "@mastra/core/tools";
import {
  mcp as mcpRoutes,
  workflows as workflowRoutes,
} from "@mastra/server/handlers";
import type { Mastra } from "@mastra/core/mastra";
import type { RequestContext } from "@mastra/core/request-context";
import type { AnyWorkflow } from "@mastra/core/workflows";
import type { ServerContext } from "@mastra/server/server-adapter";
import type { RuntimeProfileReference } from "@seqlane/core";
import { runtimeProfileReferenceSchema } from "@seqlane/core";
import { z } from "zod";

export const MCP_SERVER_ID = "seqlane-workflows";
const MCP_ABORT_SIGNAL_CONTEXT_KEY = "seqlane.mcp.abortSignal";

export interface MastraServerRequestContext {
  // Preserve the caller's RequestContext schema across the private boundary.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly requestContext: RequestContext<any>;
  readonly abortSignal: AbortSignal;
}

export interface MastraMcpInvocation {
  readonly workflowKey: string;
  readonly input: unknown;
  readonly runtime?: RuntimeProfileReference;
  // Preserve the caller's RequestContext schema across the private boundary.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly requestContext: RequestContext<any>;
  readonly abortSignal: AbortSignal;
}

export type MastraMcpDispatcher = (
  invocation: MastraMcpInvocation,
) => Promise<unknown>;

export interface MastraMcpDispatcherOptions {
  readonly maxConcurrent?: number;
  readonly maxQueued?: number;
  readonly deadlineMs?: number;
}

export interface MastraServerOptions {
  /** Adds the server-owned runtime profile envelope to workflow MCP tools. */
  readonly runtimeProfileInput?: boolean;
}

interface QueuedMcpInvocation {
  readonly invocation: MastraMcpInvocation;
  readonly controller: AbortController;
  readonly resolve: (value: unknown) => void;
  readonly reject: (cause: unknown) => void;
  readonly cleanup: () => void;
  started: boolean;
  settled: boolean;
  slotReleased: boolean;
}

class BoundedMcpDispatcher {
  private readonly maxConcurrent: number;
  private readonly maxQueued: number;
  private readonly deadlineMs: number;
  private readonly queue: QueuedMcpInvocation[] = [];
  private active = 0;

  constructor(
    private readonly dispatch: MastraMcpDispatcher,
    options: MastraMcpDispatcherOptions = {},
  ) {
    this.maxConcurrent = options.maxConcurrent ?? 4;
    this.maxQueued = options.maxQueued ?? 16;
    this.deadlineMs = options.deadlineMs ?? 30_000;
    if (this.maxConcurrent < 1 || !Number.isInteger(this.maxConcurrent)) {
      throw new TypeError("MCP maxConcurrent must be a positive integer");
    }
    if (this.maxQueued < 0 || !Number.isInteger(this.maxQueued)) {
      throw new TypeError("MCP maxQueued must be a non-negative integer");
    }
    if (this.deadlineMs < 1 || !Number.isFinite(this.deadlineMs)) {
      throw new TypeError("MCP deadlineMs must be a positive number");
    }
  }

  dispatchInvocation(invocation: MastraMcpInvocation): Promise<unknown> {
    if (invocation.abortSignal.aborted) {
      return Promise.reject(new Error("MCP workflow invocation was cancelled"));
    }
    if (
      this.queue.length >= this.maxQueued &&
      this.active >= this.maxConcurrent
    ) {
      return Promise.reject(new Error("MCP workflow dispatcher queue is full"));
    }

    const controller = new AbortController();
    const onCallerAbort = (): void => {
      if (!entry.started) {
        this.remove(entry);
        this.reject(entry, new Error("MCP workflow invocation was cancelled"));
        this.pump();
        return;
      }
      controller.abort(invocation.abortSignal.reason);
    };
    invocation.abortSignal.addEventListener("abort", onCallerAbort, {
      once: true,
    });

    let entry!: QueuedMcpInvocation;
    const deadline = setTimeout(() => {
      if (entry.started) {
        controller.abort(
          new Error("MCP workflow invocation deadline exceeded"),
        );
        this.reject(
          entry,
          new Error("MCP workflow invocation deadline exceeded"),
        );
        this.releaseSlot(entry);
        return;
      }
      this.remove(entry);
      this.reject(
        entry,
        new Error("MCP workflow invocation deadline exceeded"),
      );
    }, this.deadlineMs);
    const cleanup = (): void => {
      clearTimeout(deadline);
      invocation.abortSignal.removeEventListener("abort", onCallerAbort);
    };
    const promise = new Promise<unknown>((resolve, reject) => {
      entry = {
        invocation,
        controller,
        resolve,
        reject,
        cleanup,
        started: false,
        settled: false,
        slotReleased: false,
      };
    });
    this.queue.push(entry);
    this.pump();
    return promise;
  }

  private remove(entry: QueuedMcpInvocation): void {
    const index = this.queue.indexOf(entry);
    if (index >= 0) this.queue.splice(index, 1);
  }

  private reject(entry: QueuedMcpInvocation, cause: unknown): void {
    if (entry.settled) return;
    entry.settled = true;
    entry.cleanup();
    entry.reject(cause);
  }

  private releaseSlot(entry: QueuedMcpInvocation): void {
    if (!entry.started || entry.slotReleased) return;
    entry.slotReleased = true;
    this.active -= 1;
    this.pump();
  }

  private pump(): void {
    while (this.active < this.maxConcurrent) {
      const entry = this.queue.shift();
      if (entry === undefined) return;
      if (entry.controller.signal.aborted) {
        this.reject(entry, new Error("MCP workflow invocation was cancelled"));
        continue;
      }
      entry.started = true;
      this.active += 1;
      void this.run(entry);
    }
  }

  private async run(entry: QueuedMcpInvocation): Promise<void> {
    try {
      const result = await this.dispatch({
        ...entry.invocation,
        abortSignal: entry.controller.signal,
      });
      entry.settled = true;
      entry.resolve(result);
    } catch (cause) {
      entry.settled = true;
      entry.reject(cause);
    } finally {
      entry.cleanup();
      this.releaseSlot(entry);
    }
  }
}

export interface MastraRuntimeServer {
  listWorkflows(context: MastraServerRequestContext): Promise<unknown>;
  listMcpServers(context: MastraServerRequestContext): Promise<unknown>;
  listMcpTools(
    serverId: string,
    context: MastraServerRequestContext,
  ): Promise<unknown>;
  executeMcpTool(
    serverId: string,
    toolId: string,
    data: unknown,
    context: MastraServerRequestContext,
  ): Promise<unknown>;
}

function serverContext(
  mastra: Mastra,
  context: MastraServerRequestContext,
): ServerContext {
  const requestContext = context.requestContext;
  const abortSignal = context.abortSignal;
  requestContext.setRaw(MCP_ABORT_SIGNAL_CONTEXT_KEY, abortSignal);
  return {
    mastra,
    requestContext,
    abortSignal,
  };
}

export function registerMastraServer(
  mastra: Mastra,
  workflows: Record<string, AnyWorkflow>,
  dispatchMcpInvocation: MastraMcpDispatcher,
  dispatcherOptions?: MastraMcpDispatcherOptions,
  options: MastraServerOptions = {},
): MastraRuntimeServer {
  for (const [key, workflow] of Object.entries(workflows)) {
    if (
      typeof workflow.description !== "string" ||
      workflow.description.trim().length === 0
    ) {
      throw new TypeError(
        `Mastra workflow "${key}" must define a non-empty description before MCP registration`,
      );
    }
  }

  const boundedDispatcher = new BoundedMcpDispatcher(
    dispatchMcpInvocation,
    dispatcherOptions,
  );
  const tools: Record<string, ReturnType<typeof createTool>> = {};
  for (const [key, workflow] of Object.entries(workflows)) {
    const toolId = `run_${key}`;
    const inputSchema = options.runtimeProfileInput
      ? z.strictObject({
          // Mastra's compiled workflow schema is a Standard Schema at this
          // private integration edge; preserve it as the nested validator.
          input: workflow.inputSchema as unknown as z.ZodType,
          runtime: runtimeProfileReferenceSchema
            .optional()
            .default({ id: "opencode" }),
        })
      : workflow.inputSchema;
    tools[toolId] = createTool({
      id: toolId,
      description: `Run workflow '${key}'. Workflow description: ${workflow.description}`,
      inputSchema,
      execute: async (input, context) => {
        const abortSignal =
          context.mcp?.extra.signal ??
          context.abortSignal ??
          (context.requestContext.getRaw(MCP_ABORT_SIGNAL_CONTEXT_KEY) as
            AbortSignal | undefined);
        if (abortSignal === undefined) {
          throw new Error(
            "MCP workflow execution requires a request-bound abort signal",
          );
        }
        const workflowInput = options.runtimeProfileInput
          ? (input as { input: unknown; runtime: RuntimeProfileReference })
          : undefined;
        return boundedDispatcher.dispatchInvocation({
          workflowKey: key,
          input: workflowInput?.input ?? input,
          ...(workflowInput === undefined
            ? {}
            : { runtime: workflowInput.runtime }),
          requestContext: context.requestContext,
          abortSignal,
        });
      },
    });
  }

  const mcpServer = new MCPServer({
    id: MCP_SERVER_ID,
    name: "Seqlane Workflows",
    version: "0.1.0",
    tools,
  });
  mastra.addMCPServer(mcpServer, MCP_SERVER_ID);

  return {
    async listWorkflows(context) {
      return workflowRoutes.LIST_WORKFLOWS_ROUTE.handler(
        serverContext(mastra, context),
      );
    },
    async listMcpServers(context) {
      return mcpRoutes.LIST_MCP_SERVERS_ROUTE.handler(
        serverContext(mastra, context),
      );
    },
    async listMcpTools(serverId, context) {
      return mcpRoutes.LIST_MCP_SERVER_TOOLS_ROUTE.handler({
        ...serverContext(mastra, context),
        serverId,
      });
    },
    async executeMcpTool(serverId, toolId, data, context) {
      return mcpRoutes.EXECUTE_MCP_SERVER_TOOL_ROUTE.handler({
        ...serverContext(mastra, context),
        serverId,
        toolId,
        data,
      });
    },
  };
}
