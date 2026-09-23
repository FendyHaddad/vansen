// Tool result builders. Success: a short human summary plus a JSON block in
// one text item, then any image/resource_link blocks. Failure: isError with
// one plain sentence, what the user can do, and the code as JSON. Failures
// are never JSON-RPC protocol errors (spec §4).
import type { CallToolResult } from "npm:@modelcontextprotocol/sdk@1.30.0/types.js";
import type { ToolOutcome } from "./tool-kit.ts";

export const APP_URL = "vansen.vankode.com";
export const BILLING_URL = `${APP_URL}/app/billing`;

type Block = CallToolResult["content"][number];

function textWithJson(summary: string, data: unknown): string {
  return `${summary}\n${JSON.stringify(data, null, 2)}`;
}

export function ok(
  summary: string,
  data: unknown,
  blocks: Block[] = [],
  outcome = "ok",
): ToolOutcome {
  return {
    result: { content: [{ type: "text", text: textWithJson(summary, data) }, ...blocks] },
    outcome,
  };
}

export function toolError(
  code: string,
  sentence: string,
  action = "",
  extra: Record<string, unknown> = {},
): ToolOutcome {
  const message = action ? `${sentence} ${action}` : sentence;
  return {
    result: {
      isError: true,
      content: [{ type: "text", text: textWithJson(message, { error: code, ...extra }) }],
    },
    outcome: code,
  };
}
