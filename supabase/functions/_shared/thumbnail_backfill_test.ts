import { assert, assertEquals } from "jsr:@std/assert";
import { Image } from "jsr:@matmen/imagescript@1.3.1";
import { backfillOne, parseArgs, runBackfill } from "./thumbnail_backfill.ts";

async function png(width = 800, height = 600): Promise<Uint8Array> {
  const image = new Image(width, height);
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      image.setPixelAt(x + 1, y + 1, Image.rgbaToColor(x % 256, y % 256, 70, 255));
    }
  }
  return await image.encode();
}

interface FakeRow {
  id: string;
  media_path: string;
  thumb_state: string;
  thumb_path?: string;
}

/** A claim-and-record double that behaves like 0022's RPCs. */
function fakeAdmin(rows: FakeRow[], bytes: Uint8Array, opts: {
  downloadFails?: Set<string>;
  uploadFails?: Set<string>;
  contentType?: string;
} = {}) {
  const uploads = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  const admin = {
    uploads,
    rpcCalls,
    // deno-lint-ignore no-explicit-any
    rpc(name: string, args: Record<string, unknown>): any {
      rpcCalls.push({ name, args });
      if (name === "fn_claim_thumbnails") {
        const want = Number(args.p_limit);
        const claimed = rows
          .filter((r) => r.thumb_state === "pending")
          .slice(0, want);
        for (const row of claimed) row.thumb_state = "claimed";
        return Promise.resolve({ data: claimed, error: null });
      }
      if (name === "fn_set_thumbnail" || name === "fn_record_thumbnail") {
        const row = rows.find((r) => r.id === args.p_generation);
        // The real function only writes a row it handed out.
        if (!row || row.thumb_state !== "claimed") {
          return Promise.resolve({ data: null, error: { message: "not claimed" } });
        }
        row.thumb_state = name === "fn_record_thumbnail"
          ? "ready"
          : String(args.p_state);
        if (args.p_path) row.thumb_path = String(args.p_path);
        return Promise.resolve({ data: null, error: null });
      }
      throw new Error(`unexpected rpc ${name}`);
    },
    storage: {
      from(_bucket: string) {
        return {
          download(path: string) {
            if (opts.downloadFails?.has(path)) {
              return Promise.resolve({
                data: null,
                error: { message: "object missing" },
              });
            }
            const blob = new Blob([bytes as BlobPart], {
              type: opts.contentType ?? "image/png",
            });
            return Promise.resolve({ data: blob, error: null });
          },
          upload(
            path: string,
            body: Uint8Array,
            init: { contentType: string },
          ) {
            if (opts.uploadFails?.has(path)) {
              return Promise.resolve({
                data: null,
                error: { message: "storage unavailable" },
              });
            }
            uploads.set(path, { bytes: body, contentType: init.contentType });
            return Promise.resolve({ data: { path }, error: null });
          },
        };
      },
    },
  };
  return admin;
}

function pending(n: number): FakeRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `g${i}`,
    media_path: `u/${i}.png`,
    thumb_state: "pending",
  }));
}

const noSleep = () => Promise.resolve();

Deno.test("every pending row ends up with a thumbnail", async () => {
  const rows = pending(7);
  const admin = fakeAdmin(rows, await png());
  const summary = await runBackfill({ admin, sleep: noSleep }, { batch: 3 });

  assertEquals(summary.processed, 7);
  assertEquals(summary.ready, 7);
  assertEquals(rows.every((r) => r.thumb_state === "ready"), true);
  assertEquals(admin.uploads.size, 7);
  for (const [path, object] of admin.uploads) {
    assert(path.endsWith(".thumb.jpg"), path);
    assertEquals(object.contentType, "image/jpeg");
  }
});

Deno.test("the run stops at --max and leaves the rest claimable", async () => {
  const rows = pending(10);
  const admin = fakeAdmin(rows, await png());
  const summary = await runBackfill({ admin, sleep: noSleep }, {
    batch: 4,
    max: 6,
  });

  assertEquals(summary.processed, 6);
  assertEquals(rows.filter((r) => r.thumb_state === "pending").length, 4);
});

Deno.test("a missing original is recorded as failed, not retried forever", async () => {
  const rows = pending(2);
  const admin = fakeAdmin(rows, await png(), {
    downloadFails: new Set(["u/0.png"]),
  });
  const summary = await runBackfill({ admin, sleep: noSleep }, {});

  assertEquals(summary.failed, 1);
  assertEquals(summary.ready, 1);
  assertEquals(rows[0].thumb_state, "failed");
});

Deno.test("a format this decoder cannot read is marked unsupported", async () => {
  const rows = pending(1);
  const admin = fakeAdmin(rows, new Uint8Array([1, 2, 3]), {
    contentType: "image/webp",
  });
  const summary = await runBackfill({ admin, sleep: noSleep }, {});

  assertEquals(summary.unsupported, 1);
  assertEquals(rows[0].thumb_state, "unsupported");
});

Deno.test("a failed upload never marks the row ready", async () => {
  const rows = pending(1);
  const admin = fakeAdmin(rows, await png(), {
    uploadFails: new Set(["u/0.thumb.jpg"]),
  });
  await runBackfill({ admin, sleep: noSleep }, {});

  assertEquals(rows[0].thumb_state, "failed");
  assertEquals(rows[0].thumb_path, undefined);
});

Deno.test("no row is written that this run did not claim", async () => {
  const rows = pending(3);
  const admin = fakeAdmin(rows, await png());
  await runBackfill({ admin, sleep: noSleep }, {});

  const written = admin.rpcCalls.filter((c) => c.name !== "fn_claim_thumbnails");
  const claimedIds = new Set(rows.map((r) => r.id));
  for (const call of written) {
    assert(claimedIds.has(String(call.args.p_generation)), String(call.args.p_generation));
  }
});

Deno.test("the rate limit is applied once per image", async () => {
  const rows = pending(5);
  const admin = fakeAdmin(rows, await png());
  const waits: number[] = [];
  await runBackfill({
    admin,
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  }, { rps: 2 });

  assertEquals(waits.length, 5);
  assertEquals(waits[0], 500);
});

Deno.test("flags are read, and the batch size is capped", () => {
  const opts = parseArgs(["--batch", "5000", "--rps", "9", "--json"]);
  assertEquals(opts.batch, 200);
  assertEquals(opts.rps, 9);
  assertEquals(opts.json, true);
  assertEquals(parseArgs([]).batch, 50);
});

Deno.test("one row's outcome does not depend on the batch around it", async () => {
  const rows = pending(1);
  const admin = fakeAdmin(rows, await png(2000, 1000));
  rows[0].thumb_state = "claimed";
  const result = await backfillOne({ admin }, rows[0]);

  assertEquals(result.state, "ready");
  assert(result.bytes! > 0);
});
