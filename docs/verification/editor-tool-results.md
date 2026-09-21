# Editor tool verification (P7 Task 6)

Written 2026-09-21, against working-tree changes on top of `49bc09946545`
(uncommitted — P7 Tasks 1–5). Covers T14, spec sections 4 and 6.

**Status: incomplete, and deliberately marked so.** Step 1 is done. Steps 2–4
need a device matrix and real inference runs that this environment cannot
provide, and the plan's own rule applies: *"A missing device or real-model run
is blocked evidence, not a pass."* Every row below that was not run says so.
R17 and R18 stay open until the matrix is filled.

## Step 1 — fixtures and executable invariants (done)

Fixtures: `docs/verification/editor-fixtures.json`, nine images covering the
colour chart, checkerboard, non-square landscape, fine hair, transparent edge,
blurred, flat colour, noisy low-light and 4K cases. Each entry records its
SHA-256, dimensions, alpha, purpose and provenance.

They are **generated, not committed**: `scripts/make-editor-fixtures.ts`
produces every one from a seeded generator with no `Math.random` anywhere, so
a regeneration is byte-identical and verifiable against the recorded hashes.
That keeps ~4 MB of PNGs out of the repository and avoids the licensing
question a downloaded photograph would raise — every pixel is ours. Verified
reproducible: two independent runs produced identical hashes for all nine.

Model revisions, hashes, sizes, tensor sources and licenses:
`docs/verification/model-integrity.md`. Task 4 replaced every mutable
`resolve/main` URL with a pinned 40-character commit **before** the hashes
were measured, and `model-manifest.spec.ts` fails if one comes back.

### Automated regressions now in the suite

| Invariant | Where |
| --- | --- |
| Zero-strength identity for adjust, sharpen/smooth, liquify, filters, dehaze, portrait smooth | `ops/ops.spec.ts` |
| Crop, rotate90, rotate90ccw, flip and straighten coordinates | `ops/ops.spec.ts`, `ops/containment.spec.ts` |
| Rotate/flip are exact inverses of themselves | `ops/containment.spec.ts` |
| Pixels outside a clone, retouch or heal mask are bit-identical | `ops/containment.spec.ts` |
| A point maps to the same object after a crop | `ops/containment.spec.ts` |
| Alpha untouched by adjust and by all 17 filter presets | `ops/containment.spec.ts` |
| Selection masks invalidate on session, revision or dimension change | `selection-stamp.spec.ts` |
| Exact undo/redo, byte-bounded history, contiguous eviction | `edit-engine.spec.ts` |
| Upscale rejects over-cap input before any allocation or session | `engines/upscale-engine.spec.ts` |
| Preview/commit focus parity, proxy geometry | `editor-policy.spec.ts`, `edit-session.spec.ts` |
| One active preview run plus one replacement | `preview-scheduler.spec.ts` |
| Model integrity, size guard, cache eviction on mismatch | `engines/model-loader.spec.ts` |
| Session acquire/release, single disposal, retry after failure | `engines/session-lifetime.spec.ts` |
| Private-window and quota fallbacks for personal media | `core/media/media-cache.spec.ts` |

397 Angular specs and 390 Deno tests pass; `npx ng build` is clean.

JPEG flattening (`bufferToBlob` composites over white before encoding, so a
cut-out does not export as black) is **not** covered by an automated test:
`OffscreenCanvas.convertToBlob` is not implemented in the test environment.
It needs a real browser, so it belongs to the Step 2 matrix below.

## Step 2 — the runtime matrix (NOT RUN)

Nothing in this section was executed. No row may be read as a pass.

| Scenario | Status | Why |
| --- | --- | --- |
| 2 MP and 4K slider drag for 5 s | not run | Needs a browser with real weights; no device matrix here |
| Crop/zoom/brush while models initialize | not run | Same |
| 20+ operations and 20 undo attempts | partly covered | Byte bound and contiguous eviction are unit-tested; the *measured* memory on a device is not |
| Upscale at cap and one pixel above | partly covered | Rejection-before-allocation is unit-tested; peak working memory is not measured |
| Cold download, slow link, cancel and retry | not run | Needs real network conditions |
| Cached model offline; uncached model offline | not run | Needs a browser with a warm Cache Storage |
| GPU absent, init failure, first inference failure | not run | The CPU hot-swap exists in the upscale and sharpen engines and is lease-aware, but only a real device proves it |
| Hair/alpha, blur, noisy, flat-colour, tile-edge outputs | not run | Fixtures exist; the inference to run them on does not |
| Private window and denied/full storage | partly covered | `MediaCache` fallbacks are unit-tested; an end-to-end open/edit/save in a private window is not |
| 500 library items with timestamp ties | partly covered | Server paging, ties and one-signature-per-row are proven in `api/library_pagination_test.ts`; the *client* scroll behaviour at 500 items is not measured |
| Real worker A→B, delayed save, close-mid-inference | partly covered | `edit-lifetime.spec.ts` covers this with a fake worker; a real worker run is not done |

Per-tool output correctness for adjust, the 17 filters, sharpen/smooth,
dehaze, portrait smooth, enhance/levels, clone/retouch/liquify, perspective,
heal, smart select/erase, cut out, bokeh, local upscale and AI Sharpen:
**pure ops are covered by unit tests against fixtures; every ONNX-backed tool
(heal, smart select, erase, cut out, bokeh, upscale, AI Sharpen) has no
real-weight run recorded.** Fake tensors are explicitly not sufficient.

Peak memory, FPS and cold/warm timings: **unavailable.** No value is recorded
rather than estimated.

## Step 3 — production limits (PROVISIONAL)

`EDITOR_PIXEL_POLICY` is 40 MP in / 80 MP out, and `DEFAULT_MAX_HISTORY_BYTES`
is 192 MB. These are reasoned guesses covering every output the product can
currently generate plus a customer upload, kept in one file so they move
together. The plan requires them to be chosen from the smallest supported
device's evidence; that evidence does not exist yet, so they are provisional
and must be revisited when Step 2 runs.

## Step 4 — release record

P7 cannot close R17/R18 on this evidence, and this document does not claim it
does. What is closed: the mechanisms (bounds, guards, integrity, lifetimes,
paging) exist, are unit-tested, and were each proven non-vacuous by mutation.
What is open: every measurement and every real-weight output inspection.

**Blocked on:** a Chrome run, a Safari run, a lower-memory device, and a
deployed or locally-served build to run them against. Add the filled matrix
here, against the exact revision, before P9 rechecks it.

## Run record (2026-09-21)

Working tree, uncommitted, on top of `49bc099`. Node 22.23.1, Deno as
installed on the machine, macOS 27.0.

| Command | Result |
| --- | --- |
| `npm test -- --watch=false` | 58 files, **397 passed, 0 failed** (1.8 s) |
| `deno test --allow-all _shared api` | **390 passed, 0 failed** (16 s) |
| `npx ng build` | clean; initial 603.25 kB raw / 144.90 kB transfer |

One environment note, not a defect: the very first `deno test` on a cold
machine failed three files — `_shared/thumbnail_test.ts`,
`_shared/thumbnail_backfill_test.ts` and `api/app_test.ts` — with an uncaught
error at 1 m 19 s. Those are exactly the three that reach
`jsr:@matmen/imagescript@1.3.1`, and it was the remote fetch of that locked
dependency failing, not the code. Both runs after the cache filled were green
and took 16 s. CI must run `deno cache` before `deno test`, or it will see
the same three red files on a fresh runner.

**What this run does and does not prove.** It proves the logic holds under
mocked inference in Node's test environment. It proves nothing about real
weights, real browsers, peak memory or frame rate, which is what Steps 2–4
were for. A green suite here is not evidence for R17 or R18.
