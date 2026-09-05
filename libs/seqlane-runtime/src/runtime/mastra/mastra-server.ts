import { MCPServer } from "@mastra/mcp";
import { createTool } from "@mastra/core/tools";
import {
  mcp as mcpRoutes,
  workflows as workflowRoutes,
} from "@mastra/server/handlers";
import type { Mastra } from "@mastra/core/mastra";
import { RequestContext } from "@mastra/core/request-context";
import type { AnyWorkflow } from "@mastra/core/workflows";
import type { ServerContext } from "@mastra/server/server-adapter";

export const MCP_SERVER_ID = "seqlane-workflows";
const MCP_ABORT_SIGNAL_CONTEXT_KEY = "seqlane.mcp.abortSignal";

export interface MastraServerRequestContext {
  readonly requestContext: RequestContext;
  readonly abortSignal: AbortSignal;
}

export interface MastraMcpInvocation {
  readonly workflowKey: string;
  readonly input: unknown;
  readonly requestContext: RequestContext;
  readonly abortSignal: AbortSignal;
}

export type MastraMcpDispatcher = (
  invocation: MastraMcpInvocation,
) => Promise<unknown>;

export interface MastraRuntimeServer {
  listWorkflows(): Promise<unknown>;
  listMcpServers(): Promise<unknown>;
  listMcpTools(serverId: string): Promise<unknown>;
  executeMcpTool(
    serverId: string,
    toolId: string,
    data: unknown,
    context: MastraServerRequestContext,
  ): Promise<unknown>;
}

function serverContext(
  mastra: Mastra,
  context?: MastraServerRequestContext,
): ServerContext {
  const requestContext = context?.requestContext ?? new RequestContext();
  const abortSignal = context?.abortSignal ?? new AbortController().signal;
  requestContext.setRaw(MCP_ABORT_SIGNAL_CONTEXT_KEY, abortSignal);
  return {
    mastra,
    requestContext,
    abortSignal,
  };
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function assertAuthenticated(
  requestContext: RequestContext,
  authInfo: unknown,
): void {
  if (
    !isPresent(requestContext.get("user")) &&
    !isPresent(requestContext.get("authInfo")) &&
    !isPresent(authInfo)
  ) {
    throw new Error(
      "MCP workflow execution requires an authenticated request context",
    );
  }
}

export function registerMastraServer(
  mastra: Mastra,
  workflows: Record<string, AnyWorkflow>,
  dispatchMcpInvocation: MastraMcpDispatcher,
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

  const tools: Record<string, ReturnType<typeof createTool>> = {};
  for (const [key, workflow] of Object.entries(workflows)) {
    const toolId = `run_${key}`;
    tools[toolId] = createTool({
      id: toolId,
      description: `Run workflow '${key}'. Workflow description: ${workflow.description}`,
      inputSchema: workflow.inputSchema,
      execute: async (input, context) => {
        const authInfo = context.mcp?.extra.authInfo;
        assertAuthenticated(context.requestContext, authInfo);
        return dispatchMcpInvocation({
          workflowKey: key,
          input,
          requestContext: context.requestContext,
          abortSignal:
            context.mcp?.extra.signal ??
            context.abortSignal ??
            (context.requestContext.getRaw(MCP_ABORT_SIGNAL_CONTEXT_KEY) as
              | AbortSignal
              | undefined) ??
            new AbortController().signal,
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
    async listWorkflows() {
      return workflowRoutes.LIST_WORKFLOWS_ROUTE.handler(serverContext(mastra));
    },
    async listMcpServers() {
      return mcpRoutes.LIST_MCP_SERVERS_ROUTE.handler(serverContext(mastra));
    },
    async listMcpTools(serverId) {
      return mcpRoutes.LIST_MCP_SERVER_TOOLS_ROUTE.handler({
        ...serverContext(mastra),
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
