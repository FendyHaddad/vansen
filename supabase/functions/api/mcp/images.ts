// Image blocks for finished generations: the 512 px JPEG thumbnail inline
// (well under client size limits) plus a resource_link to the full image's
// 7-day signed URL. Items without a stored thumbnail get only the link.
import type { CallToolResult } from "npm:@modelcontextprotocol/sdk@1.30.0/types.js";
import { encodeBase64 } from "jsr:@std/encoding/base64";
import type { ToolEnv } from "./tool-kit.ts";
import type { GenerationItem } from "./view.ts";

type Block = CallToolResult["content"][number];

/** Thumbnails are ~50 KB; anything past this is not a thumbnail. */
const THUMB_MAX_BYTES = 1_000_000;

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
};

async function thumbnailBlock(env: ToolEnv, path: string | null): Promise<Block | null> {
  if (!path) return null;
  const { data, error } = await env.ctx.admin.storage.from("media").download(path);
  if (error || !data || data.size > THUMB_MAX_BYTES) return null;
  const bytes = new Uint8Array(await data.arrayBuffer());
  return { type: "image", data: encodeBase64(bytes), mimeType: "image/jpeg" };
}

function linkBlock(item: GenerationItem, mediaPath: string): Block | null {
  if (!item.mediaUrl) return null;
  const ext = mediaPath.split(".").pop()?.toLowerCase() ?? "";
  return {
    type: "resource_link",
    uri: item.mediaUrl,
    name: `vansen-${item.id}${ext ? `.${ext}` : ""}`,
    description: "Full-size image (signed link, valid for 7 days)",
    ...(MIME_BY_EXT[ext] ? { mimeType: MIME_BY_EXT[ext] } : {}),
  };
}

export async function imageBlocks(env: ToolEnv, items: GenerationItem[]): Promise<Block[]> {
  const done = items.filter((i) => i.status === "done" && i.kind === "image");
  if (done.length === 0) return [];
  const { data } = await env.ctx.admin.from("generations")
    .select("id,thumb_path,media_path,storage_backend")
    .eq("user_id", env.userId)
    .in("id", done.map((i) => i.id));
  const rows = new Map((data ?? []).map((r) => [String(r.id), r]));
  const blocks: Block[] = [];
  for (const item of done) {
    const row = rows.get(String(item.id));
    // Images live in the Supabase `media` bucket; R2 holds video only.
    const local = row && row.storage_backend !== "r2";
    const thumb = local ? await thumbnailBlock(env, row.thumb_path ?? null) : null;
    const link = linkBlock(item, String(row?.media_path ?? ""));
    if (thumb) blocks.push(thumb);
    if (link) blocks.push(link);
  }
  return blocks;
}
