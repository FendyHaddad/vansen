# Video generation (Phase 4b) — design

Date: 2026-09-05. Status: approved design, not yet implemented.
Research inputs: `docs/superpowers/plans/2026-09-05-model-landscape-research.md`
(model landscape + Higgsfield competitor check).

## Goal

Unlock the locked "Video" teaser in the workspace for Pro users. Five video families,
full input-mode matrix (text, image, reference, keyframes, extend, edit), clips stored
in Cloudflare R2, same charge → moderate → dispatch → poll → refund pipeline as images.
Waiting experience must feel alive: phase, progress, ETA, cancel where possible, and the
user may walk away.

Out of scope: Flutter mobile video UI (separate spec), video Studio tools, webhooks,
Kling O3 / Runway Aleph video-to-video, Wan / MiniMax / Grok / FLUX video.

## Locked decisions

| Topic | Decision |
|---|---|
| Launch set | Veo 3.1 Std/Fast/Lite (Google direct), Gemini Omni Flash 1.1 (Google Interactions API), Kling 3.0 Pro (fal), Runway Gen-4.5 (Runway direct), Seedance 2.5 (fal) |
| Storage | Cloudflare R2 via S3 API (aws4fetch). Presigned 7-day GET. `storage_backend` column; images stay on Supabase Storage for now, may move later |
| Input modes | Full matrix `t2v \| i2v \| ref2v \| keyframes \| extend \| edit`, gated per family by `capabilities.modes` |
| Audio | New axis `audio: 'off' \| 'on' \| 'voice'`, selectable only on Kling. Others `included` or `none` |
| Orchestration | Client polls `GET /jobs`; server streams provider → R2 when done. No webhooks |
| Pricing | Option C: keep Pro 3750 cr / $30, Studio 1500 cr / $15, margin 0.4, 1 cr = $0.01 retail. `creditCost = ceil(providerCost / 0.6 × 100)` |
| Access | Video is Pro-only (`models.min_plan = 'pro'`). Studio users see the tab locked → plans dialog |
| Tier | Higgsfield check: parity at $15, they undercut us at $30–49. Accepted; our edges are Veo Lite / Runway / Omni, free Studio tools, no throttled queue |

## 1. Catalog and pricing — `src/app/core/catalog/model-families.ts`

Type changes:

```ts
export type AxisId = 'version' | 'aspectRatio' | 'resolution' | 'quality' | 'duration' | 'audio';
export type VideoMode = 't2v' | 'i2v' | 'ref2v' | 'keyframes' | 'extend' | 'edit';
export type AudioMode = 'off' | 'on' | 'voice';

export interface GenerationSettings {
  // existing…
  audio?: AudioMode;
  mode?: VideoMode;
  /** Google Omni multi-turn edit handle. Server-stamped. */
  interactionId?: string;
}

capabilities: {
  // existing…
  audio: 'included' | 'none' | 'selectable';   // replaces boolean
  modes?: VideoMode[];                          // video only
  /** Typical wall time in seconds per second of clip, for the ETA bar. */
  expectedSPerS?: number;
}
```

Replace the five stale video families (`veo`, `sora`, `kling`, `runway`, `seedance`)
with these five. Sora is dropped (user decision 2026-09-05). Rates are USD per second of
output (research doc, 2026-09-05).

| id | name | versions | resolutions | durations | audio | modes | providerCost $/s |
|---|---|---|---|---|---|---|---|
| `veo` | Veo 3.1 | standard / fast / lite | 720p, 1080p, 4K (lite: 720p, 1080p) | 4, 6, 8 | included | t2v, i2v, ref2v, keyframes, extend | std 0.40 (4K 0.60); fast 0.10 / 0.12 / 0.30; lite 0.05 / 0.08 |
| `omni` | Gemini Omni Flash 1.1 | — | 360p, 720p, 1080p, 4K | 4, 6, 8, 10 | included | t2v, i2v, ref2v, keyframes, extend, edit | 0.03 / 0.10 / 0.15 / 0.30 |
| `kling` | Kling 3.0 Pro | — | 1080p | 5, 10, 15 | selectable | t2v, i2v, keyframes | off 0.112 / on 0.168 / voice 0.196 |
| `runway` | Runway Gen-4.5 | — | 720p, 1080p | 5, 10 | none | t2v, i2v | 0.12 |
| `seedance` | Seedance 2.5 | — | 480p, 720p | 5, 10, 15 | included | t2v, i2v, ref2v | 0.2205 / 0.473 |

Aspect ratios stay `AR_VIDEO = ['16:9','9:16','1:1']`. Kling i2v takes its ratio from
the start image; the chip is hidden in that mode.

`providerCost(settings) = ratePerSecond(settings) × settings.durationS`. Batch is
forced to 1 for video. Client credit figure is a preview only; the server recomputes
from the shared catalog and charges that.

Daily cap constant lives here too: `VIDEO_DAILY_CAP_USD = 40`.

`expectedSPerS` starter values (wall seconds per clip second, tune after live smoke):
veo 12, omni 6, kling 20, runway 8, seedance 20.

`npm run sync-shared` regenerates `supabase/functions/_shared/` and the existing vitest
drift test guards it.

## 2. Database and storage

### Migration `supabase/migrations/0016_video.sql`

- `generations`: add `storage_backend text not null default 'supabase'
  check (storage_backend in ('supabase','r2'))`, `duration_s numeric(5,1)`,
  `width int`, `height int`, `thumb_path text`.
- `jobs`: widen `provider` check to `google | openai | fal | runway`; add
  `claimed_at timestamptz` (finalize lock, §4); add `progress numeric(4,3)` and
  `phase text` (last known provider state for the waiting UI).
- `models`: insert rows for `veo`, `omni`, `kling`, `runway`, `seedance` with
  `enabled = false`, `min_plan = 'pro'`. Delete stale video rows.
- `fail_stale_jobs` cron: per-kind window — image 10 min (unchanged), video 30 min.
  Also clears `claimed_at` older than 10 min so a crashed finalize can be retried.
- `purge_lapsed_libraries`: unchanged SQL; the Edge-side deleter dispatches on
  `storage_backend`.

### Storage adapters `supabase/functions/_shared/storage/`

```ts
interface StorageAdapter {
  put(path: string, body: Uint8Array | ReadableStream<Uint8Array>, contentType: string): Promise<void>;
  signedUrl(path: string, ttlS: number): Promise<string>;
  delete(path: string): Promise<void>;
}
export function storageFor(backend: 'supabase' | 'r2'): StorageAdapter;
```

- `supabase.ts` wraps the existing `media` bucket calls.
- `r2.ts` uses aws4fetch: streaming PUT, presigned GET (7 d = existing `SIGN_TTL_S`),
  DELETE. Endpoint `https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com/{R2_BUCKET}`.
- Paths: `videos/{userId}/{generationId}.mp4`, thumb `videos/{userId}/{generationId}.jpg`.
- Video is always `r2`; images stay `supabase`. Listing code signs via
  `storageFor(gen.storage_backend)`.

### Thumbnail = client poster

Server never decodes video. After the client sees `status = done` and `thumb_path` is
null it loads the signed mp4 in a hidden `<video>`, seeks to 0.5 s, draws to canvas,
exports JPEG q0.8, and `POST /generations/:id/thumb` (multipart, ≤ 512 KB, owner only,
generation must be a done video). Server writes it via the r2 adapter and sets
`thumb_path`. Grid shows the local blob until the upload returns. One attempt per open;
failure falls back to a dark tile with a play icon.

## 3. Provider adapters — `supabase/functions/_shared/providers/`

Contract changes in `types.ts`:

```ts
provider: 'google' | 'openai' | 'fal' | 'runway';

interface SubmitCtx {
  // existing…
  mode: VideoMode;
  referenceUrls?: string[];     // signed 1 h from `uploads` bucket; i2v [1], ref2v ≤3, keyframes [first,last]
  parentVideoUrl?: string;      // extend / edit source (signed r2 GET)
  interactionId?: string;       // Omni multi-turn
}

type CheckResult =
  | { state: 'running'; progress?: number; phase?: string; queuePosition?: number }
  | { state: 'done'; bytes: Uint8Array; contentType: string }                   // images, unchanged
  | { state: 'done'; url: string; headers?: Record<string,string>; contentType: string }  // video: server streams
  | { state: 'failed'; error: string };

interface ProviderAdapter {
  // existing submit/check…
  cancel?(providerRef: string): Promise<void>;   // absent = not cancellable
}
```

New adapters, each with a `_test.ts` using mocked `fetch`:

| file | families | submit | check | cancel |
|---|---|---|---|---|
| `google-video.ts` | `veo` | `models/{veo-3.1-*}:predictLongRunning` | `operations/{name}`; download needs `x-goog-api-key` header | none |
| `google-omni.ts` | `omni` | Interactions API; `previous_interaction_id` for edit/extend; stores `settings.interactionId` on the generation | interaction status | none |
| `runway.ts` | `runway` | `/v1/text_to_video` or `/v1/image_to_video`, header `X-Runway-Version` | `/v1/tasks/{id}` (`progress` 0–1) | `DELETE /v1/tasks/{id}` |
| `fal.ts` (extend) | `kling`, `seedance` | endpoint map: `fal-ai/kling-video/v3/pro/{text,image}-to-video`, `bytedance/seedance-2.5/{text,image,reference}-to-video` | queue status → `queuePosition` | `PUT …/requests/{id}/cancel`, only while `IN_QUEUE` |

Rules:
- `submit` throws `unsupported_mode` if `ctx.mode` is not in the family's `modes`; the
  gateway checks this BEFORE charging so it never reaches the adapter in practice.
- Provider content filter → `{ state: 'failed', error: 'provider_blocked' }` → refund,
  no strike (their filter, not ours).
- `cancel` failures are swallowed; the job is still failed + refunded locally.
- New secret `RUNWAY_API_KEY`. Google/fal reuse existing keys; `OPENAI_API_KEY` is used for moderation only.

## 4. Dispatch, poll, finalize, sweep — `supabase/functions/api/index.ts`

### `POST /generations` (video branch)

1. Load family from shared catalog; 400 `unknown_family`; 403 if `models.enabled` false
   or plan < `min_plan` (Pro gate).
2. Validate `mode ∈ modes` → 400 `unsupported_mode`. Validate reference count per mode.
3. `extend` / `edit`: `parentId` must be a done video owned by the caller → 400
   `bad_parent`.
4. Concurrency: `count(jobs where user_id = ? and generation pending and kind = 'video')
   ≥ 3` → 429 `too_many_jobs`.
5. Daily cap: `sum(price_usd) of video generations by user in last 24 h + this price >
   VIDEO_DAILY_CAP_USD` → 429 `daily_cap` with `resetsAt`.
6. Moderation (§5).
7. Price = shared `providerCost` × duration; `fn_charge_and_generate` with batch 1.
8. Sign references (1 h) and parent (1 h), build `SubmitCtx`, `adapter.submit`,
   insert `jobs` row with `provider_ref`.

Client body gains `mode`, `referencePaths[]` (uploads-bucket paths from the existing
upload endpoint), `parentId`.

### `GET /jobs`

Unchanged loop (≤ 20 ids, skips `inline`). Response item grows:

```ts
{ id, status: 'pending' | 'done' | 'failed', mediaUrl?, thumbUrl?,
  progress?: number, phase?: 'queued' | 'rendering' | 'saving', queuePosition?: number,
  cancellable: boolean, expectedS: number, startedAt: string }   // expectedS = expectedSPerS × durationS; startedAt = generations.created_at
```

`running` results persist `progress` / `phase` on `jobs` so a reload shows the same bar.

### `finishJob` — url shape

1. Claim: `update jobs set claimed_at = now(), phase = 'saving' where id = ? and
   claimed_at is null returning id`. No row → another request is finalising; return
   `pending`.
2. `fetch(url, { headers })` → `storageFor('r2').put(path, res.body, 'video/mp4')`.
3. Update generation: `status = 'done'`, `media_path`, `storage_backend = 'r2'`,
   `duration_s`, `width`, `height` (from settings / provider metadata).
4. `notifySettled` once (existing push).
5. On stream failure: clear `claimed_at`, `attempts + 1`; `attempts ≥ 3` →
   `fn_fail_job(job, 'store_failed')`.

### `POST /jobs/:id/cancel`

Owner only, generation must be pending. If adapter has `cancel` → call it (errors
ignored). Then `fn_fail_job(job, 'cancelled')` → refund. Returns the refunded credits.
Veo / Omni jobs return 409 `not_cancellable`.

### Sweep

`fail_stale_jobs` per-kind window (§2). Poll from client has backoff 3 s → 5 s after
30 s → 10 s after 2 min for video ids; image ids keep the current 2 s → 5 s.

## 5. Moderation and safety

- Prompt text and every reference image are moderated (OpenAI omni-moderation) BEFORE
  charge and BEFORE any provider call. Flag → 400 + strike + quarantine of the
  uploaded references (existing `moderation_events` evidence path).
- Extend / edit do not re-moderate the parent; it was moderated when it was made.
- No output scan. Provider-side filters cover output; a block refunds without a strike.
- `safetyId` (existing hashed user id) is forwarded to every provider that accepts one.
- Same `SUSPEND_STRIKES = 2` suspension. No face detector at launch.
- Kling `voice` mode speaks the prompt — already moderated text.
- Daily spend cap $40 / user / 24 h (§4) bounds abuse and provider-bill surprises.

## 6. Workspace UI

Existing pieces reused: Video tab (`left-panel`), Duration chips, `LibraryFilter
'video'`, `video-tag` duration badge, `JobPoller`, prefs `defaultMode` /
`defaultVideoFamily`, upload widget pattern from personas/styles.

### Left panel

- `videoLocked` becomes computed `!profile.isPro()`. Locked click opens the plans
  dialog instead of doing nothing.
- New `mode-picker` component (`.ts/.html/.css`) under the model list, shown only for
  `kind = 'video'`. Chips from `family().capabilities.modes`, labels: Text → Video,
  Image → Video, Reference, Keyframes, Extend, Edit. Family change resets to the first
  supported mode.
- Mode inputs, new `reference-drop` component (`.ts/.html/.css`):
  - `t2v` nothing. `i2v` one image. `ref2v` up to 3. `keyframes` first + last.
  - `extend` / `edit` open `video-picker-dialog` (`.ts/.html/.css`) listing the user's
    done videos; `edit` also requires a prompt.
- Audio chips via existing `option-group` only when `capabilities.audio ===
  'selectable'`. `'included'` keeps the "♪ Audio included" note. `'none'` shows nothing.
- Batch control hidden for video. Aspect-ratio chips hidden for `i2v` and `keyframes` (ratio follows the input frame).
- Server error toasts: `too_many_jobs` "3 videos are still rendering — wait for one to
  finish"; `daily_cap` "Daily video limit reached, resets in {h}h"; `unsupported_mode`;
  `bad_parent`; Pro gate → plans dialog.

### Waiting experience (impatient-user UX)

The pending video card is a status card, not a spinner:

- Phase label + bar: Queued → Rendering → Saving → Done. Real progress where the
  provider reports it (Runway 0–1, fal queue position → "3rd in queue").
  Where none (Veo, Omni) the bar is estimated from `expectedSPerS × durationS`, eases
  to 90 % and holds with "Almost there…".
- ETA countdown "~2 min left" plus elapsed. Past 2× expected: "Taking longer than
  usual. Still working — if it fails you're refunded automatically."
- Cancel button when `cancellable`. Click → `POST /jobs/:id/cancel` → card flips to
  "Cancelled. Refunded N cr." Non-cancellable jobs show a disabled "Can't cancel —
  already rendering" hint.
- "You can leave this page. We'll notify you when it's ready." Poller is a root
  service and survives route changes; existing push fires on settle. Browser tab title
  prefixes `(n) Rendering…`; a toast with a View button fires on done when the user is
  elsewhere in the app.
- Top-bar chip "Rendering 2 videos ▾" with a dropdown of mini status cards, visible on
  every page while anything is pending.
- Reload: pending rows come from the DB, poller resumes, bar picks up from
  `startedAt`, last persisted `progress` / `phase` are shown immediately.
- `JobPoller` backoff: video 3 s → 5 s (after 30 s) → 10 s (after 2 min); the bar
  animates smoothly between ticks so backoff is invisible.

### Library grid and detail overlay

- Video tile: `<img>` from `thumbUrl` poster, play-icon overlay, duration badge
  (exists). Pending → status card above. Poster generation runs in
  `core/media/poster-service.ts` when a done video has no `thumb_path`.
- `detail-overlay`: video → `<video controls playsinline preload="metadata"
  [poster]="thumbUrl">` instead of `<img>`. Download = signed mp4. Studio "Edit" hidden
  for video. New actions Extend and Edit set the left panel to that mode with this
  item as parent and close the overlay.

### Preferences

Add `defaultVideoMode`. Settings tab family list refreshed to the five new ids.

### Files

New: `workspace/mode-picker/`, `workspace/reference-drop/`,
`workspace/video-picker-dialog/`, `workspace/pending-video-card/`,
`workspace/rendering-chip/` (each `.ts/.html/.css`), `core/media/poster-service.ts`.
Modified: `model-families.ts`, `left-panel.*`, `library-grid.*`, `detail-overlay.*`,
`job-poller.ts`, `dtos.ts`, `generation-store.ts`, `preferences-service.ts`,
`preferences-tab.*`.

## 7. Errors, secrets, tests, rollout

### Error → what the user sees

| Cause | Server | Card / toast |
|---|---|---|
| Provider rejects prompt | `provider_blocked`, refund, no strike | "Provider declined this prompt. Refunded N cr." |
| Provider fail / timeout | `fn_fail_job`, refund | "Generation failed. Refunded." + Retry (exists) |
| Stream to R2 fails ×3 | `store_failed`, refund | same |
| Stuck > 30 min | sweep `timeout`, refund | same |
| Cancel | `cancelled`, refund | "Cancelled. Refunded." |
| Our moderation flag | 400 + strike | existing toast + strike warning |
| 3 pending | 429 `too_many_jobs` | see §6 |
| > $40 / 24 h | 429 `daily_cap` | see §6 |
| Not Pro | 403 | plans dialog |
| Signed URL expired | list re-signs on every load | invisible |
| Poster fail | — | dark tile + play icon, retried next open |

### Secrets (Edge Function secrets only — never in the repo)

New: `RUNWAY_API_KEY`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
`R2_BUCKET`. Existing `GOOGLE_AI_API_KEY`, `OPENAI_API_KEY`, `FAL_API_KEY` reused.

### R2 setup (user, needs Cloudflare login)

1. Create bucket `vansen-media`, no public access, no lifecycle rule (purge cron owns
   deletion).
2. Create an API token "Object Read & Write" scoped to that bucket.
3. `supabase secrets set R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=…
   R2_BUCKET=vansen-media RUNWAY_API_KEY=…`.
4. No CORS needed — playback uses presigned GET directly.

### Tests

- Deno (`cd supabase/functions && deno test --allow-all _shared`): one `_test.ts` per
  adapter (submit → ref; check running / done-url / failed; blocked →
  `provider_blocked`; cancel), `storage/r2_test.ts` (presign shape, put call),
  gateway helpers for price calc, mode validation, job cap, daily cap.
- Vitest (`npm test -- --watch=false`): catalog drift, `creditCost` per family,
  mode-picker, audio chips, poster-service (canvas mocked), `JobPoller` backoff (fake
  timers), pending-video-card ETA / phase / cancel states, rendering-chip.
- Gate: `ng build` clean via nvm 22.23.1.

### Rollout

1. Apply `0016_video.sql` via MCP; `models` rows `enabled = false`.
2. `npm run sync-shared`.
3. User sets secrets and creates the R2 bucket.
4. Deploy `api` via CLI `supabase functions deploy api --no-verify-jwt` (MCP deploy is
   broken for this function). Bundle must include `_shared/providers/` and
   `_shared/storage/`.
5. Live smoke, cheapest setting per family (≈ $3–4 total), flip `enabled = true` one
   family at a time. Kill switch remains `models.enabled`.
6. Front end ships alongside; the tab unlocks for Pro automatically.
7. Update `vansen.md`, `CLAUDE.md`, `docs/superpowers/punchlist.md`. Flutter video =
   separate spec.
