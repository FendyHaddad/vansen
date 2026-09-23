// One McpServer per /mcp request (stateless), with the v1 tools registered.
// runTool() is the wrapper every call goes through: the per-tool age gate,
// exceptions turned into a tool error + an app_errors row (client 'mcp'),
// and one structured log line (user, client, grant, tool, outcome, ms).
import { McpServer } from "npm:@modelcontextprotocol/sdk@1.30.0/server/mcp.js";
import type { CallToolResult } from "npm:@modelcontextprotocol/sdk@1.30.0/types.js";
import type { z } from "npm:zod@4";
import { mappedError } from "./errors.ts";
import { toolError } from "./results.ts";
import type { ToolCall, ToolDef, ToolEnv, ToolOutcome } from "./tool-kit.ts";
import { TOOLS } from "./tools/index.ts";

const INSTRUCTIONS =
  "Vansen generates images on the user's own Vansen account and spends its credits " +
  "(1 credit = $0.01). Call list_models for models, options and prices before choosing " +
  "non-default options. generate_image waits up to 25 s; if images are still rendering, " +
  "call get_generation with the ids it returned.";

async function outcomeOf(
  def: ToolDef<z.ZodRawShape>,
  env: ToolEnv,
  args: Record<string, unknown>,
  call: ToolCall,
): Promise<ToolOutcome> {
  try {
    if (def.ageGated && !(await env.ctx.ageConfirmed(env.userId))) {
      return mappedError("age_unconfirmed", "");
    }
    return await def.run(env, args as never, call);
  } catch (err) {
    env.ctx.logError(env.c, "mcp_tool_failed", err);
    return toolError(
      "internal",
      "Something went wrong on Vansen's side.",
      "Try again in a moment.",
      { errorId: env.c.get("requestId") },
    );
  }
}

async function runTool(
  def: ToolDef<z.ZodRawShape>,
  env: ToolEnv,
  args: Record<string, unknown>,
  call: ToolCall,
): Promise<CallToolResult> {
  const started = performance.now();
  const { result, outcome } = await outcomeOf(def, env, args, call);
  console.log(JSON.stringify({
    event: "mcp_tool",
    user: env.userId,
    clientId: env.clientId,
    grantId: env.grantId,
    tool: def.name,
    outcome,
    ms: Math.round(performance.now() - started),
    requestId: env.c.get("requestId"),
  }));
  return result;
}

export function buildMcpServer(env: ToolEnv): McpServer {
  const server = new McpServer(
    { name: "vansen", title: "Vansen", version: "1.0.0" },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  for (const def of TOOLS as unknown as ToolDef<z.ZodRawShape>[]) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.inputSchema,
        annotations: { title: def.title, ...def.annotations },
      },
      (args: Record<string, unknown>, extra: { requestId: string | number }) =>
        runTool(def, env, args, { rpcId: extra.requestId }),
    );
  }
  return server;
}
