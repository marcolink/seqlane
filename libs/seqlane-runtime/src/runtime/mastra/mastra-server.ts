import { MCPServer } from "@mastra/mcp";
import {
  mcp as mcpRoutes,
  workflows as workflowRoutes,
} from "@mastra/server/handlers";
import type { Mastra } from "@mastra/core/mastra";
import { RequestContext } from "@mastra/core/request-context";
import type { AnyWorkflow } from "@mastra/core/workflows";
import type { ServerContext } from "@mastra/server/server-adapter";

export const MCP_SERVER_ID = "seqlane-workflows";

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

  const mcpServer = new MCPServer({
    id: MCP_SERVER_ID,
    name: "Seqlane Workflows",
    version: "0.1.0",
    tools: {},
    // MCPServer's public config currently uses Workflow rather than the
    // broader runtime registry type. The registry entries are checked by
    // Mastra and MCPServer before they are exposed as tools.
    workflows: workflows as never,
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
