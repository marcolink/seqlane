import { Context, Effect, Layer, Schema } from "effect";
import * as McpServer from "effect/ai/McpServer";
import * as McpProtocol from "effect/ai/McpProtocol";
import * as McpSchema from "effect/ai/McpSchema";
import {
  operationalRunStartRequestSchema,
  operationalRunStatusSchema,
  type OperationalRunStartRequest,
  type OperationalRunStatus,
  type OperationalWorkflow,
} from "@seqlane/protocol";
import { z } from "zod";

export const OPERATIONAL_MCP_PATH = "/api/mcp/seqlane-workflows/mcp";
const MAX_RESULT_BYTES = 16 * 1024 * 1024;

export interface OperationalMcpOptions {
  readonly workflows: readonly OperationalWorkflow[];
  /** Interruption must cancel and drain the admitted run before releasing it. */
  readonly invoke: (
    workflowKey: string,
    request: OperationalRunStartRequest,
  ) => Effect.Effect<OperationalRunStatus, unknown>;
  readonly allowedOrigins?: readonly string[];
}

function toolFailure(message: string): McpSchema.CallToolResult {
  return new McpSchema.CallToolResult({
    isError: true,
    content: [McpSchema.TextContent.make({ type: "text", text: message })],
  });
}

function toolResult(value: unknown): McpSchema.CallToolResult {
  const status = operationalRunStatusSchema.parse(value);
  const text = JSON.stringify(status);
  if (Buffer.byteLength(text, "utf8") > MAX_RESULT_BYTES) {
    return toolFailure(
      "Workflow result exceeds the MCP response byte limit; inspect the hosted run directly",
    );
  }
  return new McpSchema.CallToolResult({
    isError: status.status !== "succeeded",
    content: [McpSchema.TextContent.make({ type: "text", text })],
    structuredContent: status,
  });
}

/** Isolates the pinned unstable MCP API; Zod remains the wire contract owner. */
export function operationalMcpLayer(options: OperationalMcpOptions) {
  const transport = McpServer.layerHttp({
    name: "Seqlane Workflows",
    version: "1.0.0",
    path: OPERATIONAL_MCP_PATH,
    protocols: [
      McpProtocol.v2025_03_26,
      McpProtocol.v2025_06_18,
      McpProtocol.v2025_11_25,
      McpProtocol.v2026_07_28,
    ],
    allowedOrigins: options.allowedOrigins ?? [],
    allowSessionTermination: true,
    allowSubscriptions: false,
  });
  const register = Effect.gen(function* () {
    const registry = yield* McpServer.McpServer;
    for (const workflow of options.workflows) {
      // Decode the Zod-generated schema at the native MCP interop boundary.
      const inputSchema = Schema.decodeUnknownSync(McpSchema.ToolJson)({
        ...z.toJSONSchema(operationalRunStartRequestSchema),
        properties: {
          ...z.toJSONSchema(operationalRunStartRequestSchema).properties,
          input: workflow.input.schema,
        },
      });
      yield* registry.addTool({
        tool: new McpSchema.Tool({
          name: `run_${workflow.key}`,
          description: `Run workflow '${workflow.key}' and wait for its result`,
          inputSchema,
        }),
        annotations: Context.empty(),
        handle: (payload: unknown) =>
          Effect.try({
            try: () => operationalRunStartRequestSchema.parse(payload),
            catch: () =>
              new McpSchema.InvalidParams({
                message: "Invalid workflow run request",
              }),
          }).pipe(
            Effect.flatMap((request) =>
              options.invoke(workflow.key, request).pipe(
                Effect.timeout("30 seconds"),
                Effect.flatMap((status) =>
                  Effect.try({
                    try: () => toolResult(status),
                    catch: (cause) => cause,
                  }),
                ),
                Effect.catch(() =>
                  Effect.succeed(
                    toolFailure(
                      "Hosted workflow invocation failed; inspect the hosted run for details",
                    ),
                  ),
                ),
              ),
            ),
          ),
      });
    }
  });
  return Layer.effectDiscard(register).pipe(Layer.provideMerge(transport));
}
