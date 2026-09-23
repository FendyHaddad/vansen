// The shape every MCP tool module exports, and what it gets to work with.
// defineTool() keeps each tool's argument types; ToolEnv carries the live
// /mcp request context (so tools call the gateway's services in-process)
// plus who is calling. A tool returns a ToolOutcome: the result + a log label.
import type { Context } from "jsr:@hono/hono";
import type { z } from "npm:zod@4";
import type {
  CallToolResult,
  ToolAnnotations,
} from "npm:@modelcontextprotocol/sdk@1.30.0/types.js";
import type { ApiContext, Vars } from "../lib/context.ts";

export interface ToolEnv {
  /** The /mcp request's context: userId, requestId and client='mcp' are set. */
  c: Context<Vars>;
  ctx: ApiContext;
  userId: string;
  /** The OAuth client and grant of the resolved access token. */
  clientId: string;
  grantId: string;
  sleep: (ms: number) => Promise<void>;
}

/** Per call: the JSON-RPC request id (idempotency derives from it). */
export interface ToolCall {
  rpcId: string | number;
}

export interface ToolOutcome {
  result: CallToolResult;
  /** For the log line: "ok", "pending", or the error code. */
  outcome: string;
}

export interface ToolDef<S extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: S;
  annotations: ToolAnnotations;
  /** Needs a confirmed 18+ birth date (all but get_account, as in the app). */
  ageGated: boolean;
  run(env: ToolEnv, args: z.infer<z.ZodObject<S>>, call: ToolCall): Promise<ToolOutcome>;
}

export function defineTool<S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef<S> {
  return def;
}
