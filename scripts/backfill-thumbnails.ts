#!/usr/bin/env -S deno run --allow-env --allow-net
// Command wrapper around _shared/thumbnail_backfill.ts.
//
// It runs on Deno, not Node, so it shares the one pinned, tested decoder the
// gateway uses. A second implementation for Node would mean two ways to
// produce a thumbnail and two ways for them to disagree.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   deno run --allow-env --allow-net scripts/backfill-thumbnails.ts \
//     [--batch 50] [--max 1000] [--rps 4] [--json]
import { createClient } from "jsr:@supabase/supabase-js@2";
import { parseArgs, runBackfill } from "../supabase/functions/_shared/thumbnail_backfill.ts";

const url = Deno.env.get("SUPABASE_URL");
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!url || !key) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  Deno.exit(2);
}

const opts = parseArgs(Deno.args);
const summary = await runBackfill({ admin: createClient(url, key) }, opts);
if (opts.json) console.log(JSON.stringify(summary, null, 2));
else {
  console.log(
    `processed ${summary.processed}: ${summary.ready} ready, ` +
      `${summary.failed} failed, ${summary.unsupported} unsupported`,
  );
}
Deno.exit(summary.failed > 0 ? 1 : 0);
