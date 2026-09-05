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

export interface MastraMcpInvocation {
  readonly workflowKey: string;
  readonly input: unknown;
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
  ): Promise<unknown>;
}

function serverContext(mastra: Mastra): ServerContext {
  return {
    mastra,
    requestContext: new RequestContext(),
    abortSignal: new AbortController().signal,
  };
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
      execute: async (input) =>
        dispatchMcpInvocation({
          workflowKey: key,
          input,
        }),
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
    async executeMcpTool(serverId, toolId, data) {
      return mcpRoutes.EXECUTE_MCP_SERVER_TOOL_ROUTE.handler({
        ...serverContext(mastra),
        serverId,
        toolId,
        data,
      });
    },
  };
}
