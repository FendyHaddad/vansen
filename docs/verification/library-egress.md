# Library egress — before and after thumbnails (P7 Task 3)

Written 2026-09-21. Covers T13 / R16 / R17.

## What changed

- `GET /generations` returns a keyset page (default 50, hard cap 100) instead
  of up to 200 rows, and signs **one** URL per row instead of two.
- Finished images get a 512 px JPEG thumbnail on the settle path
  (`_shared/thumbnail.ts`), and the grid renders that instead of the original.
- `GET /ledger` pages by the same cursor instead of truncating at 100 entries.

## Measured: thumbnail vs original

Real encodes through the shipped `makeThumbnail`, on this machine, Deno
2.x, `jsr:@matmen/imagescript@1.3.1`. Sources are synthetic images with
photographic-scale variation, so the PNGs do not compress away.

| Source | Original | Thumbnail | Share | Time (decode+resize+encode) |
| --- | --- | --- | --- | --- |
| 1024x1024 | 2493 KiB | 106 KiB | 4.3% | 133 ms |
| 1408x1408 | 4729 KiB | 132 KiB | 2.8% | 134 ms |
| 2048x1152 | 5615 KiB | 91 KiB | 1.6% | 173 ms |

A 50-tile first view therefore moves from roughly **120–280 MB** of originals
to roughly **4.5–6.5 MB** of tiles, on top of the page itself dropping from up
to 200 rows to 50.

Signing round trips for one page: **50**, down from up to 400 (200 rows x
media + thumb, awaited in sequence). Asserted by
`api/library_pagination_test.ts` — "a page signs at most one URL per row".

## Not yet measured — release blockers

These three numbers need a deployed gateway and a seeded account, and this
repository still has no staging project (see the release-hardening blockers
list). They are **not** estimated here, because an estimate in a verification
record is indistinguishable from a measurement later:

1. Bytes transferred for a real first library view, from the browser's own
   network panel.
2. Time to first tile on a cold cache.
3. Memory after scrolling 1000 items.

Take all three once `api` is redeployed with 0022 applied and the backfill has
run. Until then the grid's improvement is proven by the encode measurements
above and by the request-count assertions in the test suite, and the live
figures remain open.

## Backfill

Everything made before 0022 is marked `thumb_state = 'pending'` and has no
thumbnail, so those tiles still serve originals. Run:

```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
  deno run --allow-env --allow-net scripts/backfill-thumbnails.ts --json
```

It claims in batches, rate-limits to 4 images/second by default, records
`ready` / `failed` / `unsupported` per row, and never writes a row it did not
claim. Re-running it is safe: a crashed run's claims are released after an
hour.
