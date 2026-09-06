# Video Generation (Phase 4b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship text/image/reference-to-video generation across five provider families (Veo 3.1, Gemini Omni Flash 1.1, Kling 3.0 Pro, Runway Gen-4.5, Seedance 2.5) as a Pro-only workspace mode, with videos stored in Cloudflare R2, real progress/cancel UX, and a $40/day per-user spend cap.

**Architecture:** The Angular catalog (`model-families.ts`) is the single source of truth for families, axes and prices; `npm run sync-shared` copies it into the Edge Function. The Hono `api` gateway validates mode/references/caps, moderates, charges via `fn_charge_and_generate`, then submits to a provider adapter. Video jobs are polled by the client through `GET /jobs`; when a provider reports done the gateway streams the MP4 straight from the provider into R2 (never buffering to Supabase Storage), then marks the generation done. The client renders a phase bar (Queued → Rendering → Saving → Done) with ETA, supports cancel, and generates a poster frame locally.

**Tech Stack:** Angular 22 (standalone, signals, zoneless, OnPush), Tailwind v4, spartan/ui helm, `@ng-icons/lucide`; Supabase Edge Functions (Deno, Hono `jsr:@hono/hono`, `jsr:@supabase/supabase-js@2`), `npm:aws4fetch@1.0.20` for R2 SigV4; Postgres + pg_cron; vitest (Angular) + `deno test` (Edge).

## Global Constraints

- **Never commit, branch, or push.** Every task ends with "user commits" — the user makes all commits personally. No `git commit` steps anywhere in this plan.
- **No nested if statements.** Guard clauses and early returns only.
- **Angular components always use separate files** `.ts` + `.html` + `.css`. Never inline templates or styles. Prefer stylesheet classes over inline `style`.
- **Provider keys ONLY in Edge Function secrets.** New secrets this phase: `RUNWAY_API_KEY`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`. Never in repo.
- **Video is Pro-only**: `models.min_plan = 'pro'` for all five families; UI locks video mode for non-Pro (`profile.proActive()`), click → upgrade dialog.
- **Video always stored in R2**, images stay in Supabase `media` bucket. `generations.storage_backend ∈ ('supabase','r2')`.
- **Pricing**: `providerCost = rate × durationS`; batch forced to 1 for video; `creditCost = ceil(cost / (1 - STUDIO_MARGIN) × 100)` with `STUDIO_MARGIN = 0.4` (existing formula, unchanged).
- **Daily cap**: `VIDEO_DAILY_CAP_USD = 40` per user, computed over `ledger` provider-cost sum of video generations in the last 24 h → 429 `daily_cap` with `resetsAt`.
- **Concurrency cap**: ≥3 pending video jobs → 429 `too_many_jobs`.
- **Moderation** runs on the prompt AND every reference image BEFORE charge and BEFORE any provider call (`moderate({ text? , imageUrl? })`). Provider-side block → `provider_blocked` refund, no strike.
- **Stale sweeps**: image jobs 10 min (unchanged), video jobs 30 min. `jobs.claimed_at` older than 10 min is cleared.
- **Poller backoff**: video 3 s → 5 s (after 30 s) → 10 s (after 2 min); image 2 s → 5 s unchanged.
- **Aspect ratios**: `AR_VIDEO = ['16:9','9:16','1:1']`. Kling hides the AR chip in `i2v`.
- **Waiting UX copy** (verbatim): phase labels `Queued`, `Rendering`, `Saving`, `Done`; estimate eases to 90 % then reads `Almost there…`; `You can leave this page. We'll notify you when it's ready.`; over 2× expected: `Taking longer than usual — still working.`; tab title `(n) Rendering…`; chip `Rendering N video(s)`.
- **Error copy** (verbatim): `provider_blocked` → `Provider declined this prompt. Refunded N cr.`; `too_many_jobs` → `3 videos are still rendering — wait for one to finish`; `daily_cap` → `Daily video limit reached, resets in {h}h`; `unsupported_mode` → `This model can't do that mode.`; `bad_parent` → `Pick a finished video to extend or edit.`; `not_cancellable` → `This model can't be cancelled once started.`
- **Tests**: Angular → `npm test -- --watch=false` (never bare `npx vitest run`, it falsely fails TestBed specs). Edge → `cd supabase/functions && deno test --allow-all _shared`. Build → `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npx ng build`. Run all from repo root `/Users/user/IdeaProjects/vansen`.
- **Deploy**: `supabase functions deploy api --no-verify-jwt` from repo root (MCP deploy tool is broken for this function). Migration applied via MCP `apply_migration`. Redeploying `api` must bundle every `_shared/` file including `providers/` and new `storage/`.
- **Baseline counts** before this plan: 197 vitest, 19 deno. Every task states the new expected count.

---

## File Structure

**Catalog (Angular, synced to Edge):**
- `src/app/core/catalog/model-families.ts` — add `VideoMode`, `AudioMode`, `audio` capability enum, `modes`, `expectedSPerS`, five video families (replace veo/kling/runway/seedance, delete sora, add omni), `VIDEO_DAILY_CAP_USD`, `videoFamilySupports()`.
- `src/app/core/catalog/model-families.spec.ts` — family counts, price table, mode table.
- `supabase/functions/_shared/model-families.ts` — regenerated by `npm run sync-shared` (never hand-edit).

**Database:**
- `supabase/migrations/0016_video.sql` — generations/jobs columns, models rows, cron rewrite.

**Edge — storage layer (new):**
- `supabase/functions/_shared/storage/types.ts` — `StorageAdapter` interface.
- `supabase/functions/_shared/storage/supabase.ts` — wraps `admin.storage.from('media')`.
- `supabase/functions/_shared/storage/r2.ts` — aws4fetch SigV4 PUT/DELETE + presigned GET.
- `supabase/functions/_shared/storage/index.ts` — `storageFor(backend)`.
- `supabase/functions/_shared/storage/r2_test.ts` — signing/URL tests.

**Edge — providers:**
- `supabase/functions/_shared/providers/types.ts` — `SubmitCtx` video fields, `CheckResult` url shape + progress, `cancel?`.
- `supabase/functions/_shared/providers/google-video.ts` (new) — Veo 3.1 long-running ops.
- `supabase/functions/_shared/providers/google-omni.ts` (new) — Omni Interactions API.
- `supabase/functions/_shared/providers/runway.ts` (new) — Gen-4.5 tasks API.
- `supabase/functions/_shared/providers/fal.ts` — kling/seedance slugs + payloads, video result, cancel, queue position.
- `supabase/functions/_shared/providers/index.ts` — `BY_FAMILY` additions.
- `supabase/functions/_shared/providers/*_test.ts` — one test file per new adapter + fal video test.

**Edge — gateway:**
- `supabase/functions/_shared/video-rules.ts` (new) — pure validators: `referenceRule(mode)`, `videoJobCapReached(count)`, `dailyCapState(spentUsd, now)`. Tested in `video-rules_test.ts`.
- `supabase/functions/api/index.ts` — POST /generations video branch, GET /jobs progress shape + streaming finish, POST /jobs/:id/cancel, POST /generations/:id/thumb, DELETE dispatch, `sanitizeSettings` audio/mode, `PREF_CHECKS` defaultVideoMode.

**Angular — core:**
- `src/app/core/api/dtos.ts` — `GenerationDto` grows `thumbUrl?`, `storageBackend?`, `durationS?`, `job?`; `CreateGenerationRequest` grows `mode?`, `referencePaths?`; new `CancelJobResponse`.
- `src/app/core/jobs/job-poller.ts` — kind-aware backoff.
- `src/app/core/generations/generation-store.ts` — `cancel(id)`, `pendingVideoCount`, `setThumb`, merge `job` progress.
- `src/app/core/media/poster-service.ts` (new) — client poster frame capture + upload.
- `src/app/core/preferences/preferences-service.ts` — `defaultVideoMode`.

**Angular — workspace UI:**
- `src/app/features/workspace/left-panel/mode-picker/` (new) — t2v/i2v/ref2v/keyframes/extend/edit chips.
- `src/app/features/workspace/left-panel/reference-drop/` (new) — N-slot image drop (1 for i2v, 2 for keyframes, up to 3 for ref2v).
- `src/app/features/workspace/video-picker-dialog/` (new) — pick a finished video for extend/edit.
- `src/app/features/workspace/left-panel/` — video mode unlock, mode picker, refs, audio chips, batch hidden, AR hide rule.
- `src/app/features/workspace/pending-video-card/` (new) — phase bar, ETA, elapsed, cancel.
- `src/app/features/workspace/rendering-chip/` (new) — top bar chip + tab title.
- `src/app/features/workspace/library-grid/` — pending video card swap, poster tile.
- `src/app/features/workspace/detail-overlay/` — `<video>` player, Extend / Edit actions.
- `src/app/features/workspace/workspace-page.*` — wiring, error copy, download `.mp4`.
- `src/app/features/settings/preferences-tab/` — default video mode select.
- `src/app/core/notifications/notification-toast.*` — "View" label.

**Docs:** `vansen.md`, `CLAUDE.md`, `docs/superpowers/punchlist.md`.

---

## Tasks

### Task 1: Catalog — five video families, audio/mode capabilities, daily cap

**Files:**
- Modify: `src/app/core/catalog/model-families.ts` (types L1–46, video block L219–329, `defaultSettings` ~L432)
- Test: `src/app/core/catalog/model-families.spec.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (used by every later task):
  - `type AxisId = 'version' | 'aspectRatio' | 'resolution' | 'quality' | 'duration' | 'audio'`
  - `type VideoMode = 't2v' | 'i2v' | 'ref2v' | 'keyframes' | 'extend' | 'edit'`
  - `type AudioMode = 'off' | 'on' | 'voice'`
  - `GenerationSettings.audio?: AudioMode`, `.mode?: VideoMode`, `.interactionId?: string`
  - `ModelFamily.capabilities.audio?: 'included' | 'none' | 'selectable'`, `.modes?: VideoMode[]`, `.expectedSPerS?: number`
  - `export const VIDEO_DAILY_CAP_USD = 40`
  - `export function videoFamilySupports(family: ModelFamily, mode: VideoMode): boolean`
  - Family ids: `veo`, `omni`, `kling`, `runway`, `seedance` (no `sora`).

- [ ] **Step 1: Write failing tests**

Append inside `describe('model families', …)` in `src/app/core/catalog/model-families.spec.ts` (add `VIDEO_DAILY_CAP_USD, videoFamilySupports` to the import list):

```ts
  it('ships the five spec video families and no sora', () => {
    const ids = MODEL_FAMILIES.filter((f) => f.kind === 'video').map((f) => f.id);
    expect(ids).toEqual(['veo', 'omni', 'kling', 'runway', 'seedance']);
    expect(familyById('sora')).toBeUndefined();
  });

  it('every video family declares audio, modes and expectedSPerS', () => {
    for (const f of MODEL_FAMILIES.filter((f) => f.kind === 'video')) {
      expect(['included', 'none', 'selectable']).toContain(f.capabilities.audio);
      expect(f.capabilities.modes?.length).toBeGreaterThan(0);
      expect(f.capabilities.expectedSPerS).toBeGreaterThan(0);
      expect(f.capabilities.aspectRatios).toEqual(['16:9', '9:16', '1:1']);
    }
  });

  it('videoFamilySupports reads capabilities.modes', () => {
    expect(videoFamilySupports(familyById('runway')!, 't2v')).toBe(true);
    expect(videoFamilySupports(familyById('runway')!, 'extend')).toBe(false);
    expect(videoFamilySupports(familyById('omni')!, 'edit')).toBe(true);
    expect(videoFamilySupports(familyById('flux')!, 't2v')).toBe(false);
  });

  it('video pricing matches the spec table', () => {
    const veo = familyById('veo')!;
    expect(veo.providerCost({ aspectRatio: '16:9', version: 'standard', resolution: '1080p', durationS: 8 })).toBeCloseTo(3.2);
    expect(veo.providerCost({ aspectRatio: '16:9', version: 'standard', resolution: '4K', durationS: 8 })).toBeCloseTo(4.8);
    expect(veo.providerCost({ aspectRatio: '16:9', version: 'fast', resolution: '720p', durationS: 4 })).toBeCloseTo(0.4);
    expect(veo.providerCost({ aspectRatio: '16:9', version: 'fast', resolution: '4K', durationS: 4 })).toBeCloseTo(1.2);
    expect(veo.providerCost({ aspectRatio: '16:9', version: 'lite', resolution: '1080p', durationS: 4 })).toBeCloseTo(0.32);
    const omni = familyById('omni')!;
    expect(omni.providerCost({ aspectRatio: '16:9', resolution: '4K', durationS: 10 })).toBeCloseTo(3.0);
    const kling = familyById('kling')!;
    expect(kling.providerCost({ aspectRatio: '16:9', durationS: 5, audio: 'off' })).toBeCloseTo(0.56);
    expect(kling.providerCost({ aspectRatio: '16:9', durationS: 5, audio: 'voice' })).toBeCloseTo(0.98);
    expect(familyById('runway')!.providerCost({ aspectRatio: '16:9', durationS: 10 })).toBeCloseTo(1.2);
    expect(familyById('seedance')!.providerCost({ aspectRatio: '16:9', resolution: '480p', durationS: 5 })).toBeCloseTo(1.1025);
  });

  it('defaultSettings sets mode t2v for video and audio off when selectable', () => {
    expect(defaultSettings(familyById('kling')!)).toMatchObject({ mode: 't2v', audio: 'off', durationS: 5 });
    expect(defaultSettings(familyById('veo')!).audio).toBeUndefined();
    expect(defaultSettings(familyById('veo')!).mode).toBe('t2v');
    expect(defaultSettings(familyById('flux')!).mode).toBeUndefined();
  });

  it('exposes the daily video spend cap', () => {
    expect(VIDEO_DAILY_CAP_USD).toBe(40);
  });
```

Also update the existing test `'video cost scales with duration'` if it references `version: 'standard'` with 1080p — it still passes (0.40 × 4 = 1.6 vs 3.2).

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- --watch=false 2>&1 | tail -30`
Expected: FAIL — `videoFamilySupports is not exported`, `VIDEO_DAILY_CAP_USD` undefined, sora present.

- [ ] **Step 3: Update types (top of `model-families.ts`)**

Replace L1–46 type block with:

```ts
export type ModelKind = 'image' | 'video';
export type AxisId = 'version' | 'aspectRatio' | 'resolution' | 'quality' | 'duration' | 'audio';
export type VideoMode = 't2v' | 'i2v' | 'ref2v' | 'keyframes' | 'extend' | 'edit';
export type AudioMode = 'off' | 'on' | 'voice';
export type AudioCapability = 'included' | 'none' | 'selectable';

export interface FamilyOption {
  value: string;
  label: string;
  tooltip: string;
  tag?: string;
}

export interface GenerationSettings {
  version?: string;
  aspectRatio: string;
  resolution?: string;
  quality?: string;
  durationS?: number;
  batch?: number;
  style?: string;
  persona?: string;
  trend?: string;
  audio?: AudioMode;
  mode?: VideoMode;
  interactionId?: string;
}

export interface ModelFamily {
  id: string;
  name: string;
  provider: string;
  logo: string;
  kind: ModelKind;
  blurb: string;
  capabilities: {
    versions?: FamilyOption[];
    aspectRatios: string[];
    resolutions?: FamilyOption[];
    qualities?: FamilyOption[];
    durations?: number[];
    audio?: AudioCapability;
    modes?: VideoMode[];
    expectedSPerS?: number;
    imageInput: boolean;
    maskInput: boolean;
  };
  providerCost(settings: GenerationSettings): number;
}

const AR_IMAGE = ['1:1', '3:4', '4:3', '16:9', '9:16'];
const AR_VIDEO = ['16:9', '9:16', '1:1'];

/** Hard ceiling on provider spend for video per user per rolling 24 h. */
export const VIDEO_DAILY_CAP_USD = 40;
```

Keep everything between the type block and the video families (image families, `STUDIO_MARGIN`, plans, packs) unchanged.

- [ ] **Step 4: Replace the video block (L219–329, veo through seedance including sora) with:**

```ts
  // ── Video ───────────────────────────────────────────────────────────
  {
    id: 'veo',
    name: 'Veo 3.1',
    provider: 'Google',
    logo: '/logos/google.svg',
    kind: 'video',
    blurb: 'Veo 3.1 — cinematic clips with native audio, up to 4K.',
    capabilities: {
      versions: [
        { value: 'standard', label: 'Standard', tooltip: 'Best quality. $0.40/s, 4K $0.60/s.', tag: 'Latest' },
        { value: 'fast', label: 'Fast', tooltip: 'Quicker renders. $0.10/s (1080p $0.12, 4K $0.30).' },
        { value: 'lite', label: 'Lite', tooltip: 'Cheapest Veo. 720p/1080p only. $0.05/$0.08 per second.' },
      ],
      aspectRatios: AR_VIDEO,
      resolutions: [
        { value: '720p', label: '720p', tooltip: 'HD. Fastest and cheapest.' },
        { value: '1080p', label: '1080p', tooltip: 'Full HD.' },
        { value: '4K', label: '4K', tooltip: 'Ultra HD. Standard and Fast only.' },
      ],
      durations: [4, 6, 8],
      audio: 'included',
      modes: ['t2v', 'i2v', 'ref2v', 'keyframes', 'extend'],
      expectedSPerS: 12,
      imageInput: true,
      maskInput: false,
    },
    providerCost: (s) => veoRate(s.version, s.resolution) * (s.durationS ?? 8),
  },
  {
    id: 'omni',
    name: 'Gemini Omni Flash 1.1',
    provider: 'Google',
    logo: '/logos/google.svg',
    kind: 'video',
    blurb: 'Omni Flash — conversational video: generate, then edit or extend by talking to it.',
    capabilities: {
      aspectRatios: AR_VIDEO,
      resolutions: [
        { value: '360p', label: '360p', tooltip: 'Preview quality. $0.03/s.' },
        { value: '720p', label: '720p', tooltip: 'HD. $0.10/s.' },
        { value: '1080p', label: '1080p', tooltip: 'Full HD. $0.15/s.' },
        { value: '4K', label: '4K', tooltip: 'Ultra HD. $0.30/s.' },
      ],
      durations: [4, 6, 8, 10],
      audio: 'included',
      modes: ['t2v', 'i2v', 'ref2v', 'keyframes', 'extend', 'edit'],
      expectedSPerS: 6,
      imageInput: true,
      maskInput: false,
    },
    providerCost: (s) => omniRate(s.resolution) * (s.durationS ?? 8),
  },
  {
    id: 'kling',
    name: 'Kling 3.0 Pro',
    provider: 'Kuaishou',
    logo: '/logos/kuaishou.svg',
    kind: 'video',
    blurb: 'Kling 3.0 Pro — smooth motion, optional soundtrack or voice.',
    capabilities: {
      aspectRatios: AR_VIDEO,
      durations: [5, 10, 15],
      audio: 'selectable',
      modes: ['t2v', 'i2v', 'keyframes'],
      expectedSPerS: 20,
      imageInput: true,
      maskInput: false,
    },
    providerCost: (s) => klingRate(s.audio) * (s.durationS ?? 5),
  },
  {
    id: 'runway',
    name: 'Runway Gen-4.5',
    provider: 'Runway',
    logo: '/logos/runway.svg',
    kind: 'video',
    blurb: 'Gen-4.5 — director-grade control and consistency. Silent.',
    capabilities: {
      aspectRatios: AR_VIDEO,
      resolutions: [
        { value: '720p', label: '720p', tooltip: 'HD.' },
        { value: '1080p', label: '1080p', tooltip: 'Full HD.' },
      ],
      durations: [5, 10],
      audio: 'none',
      modes: ['t2v', 'i2v'],
      expectedSPerS: 8,
      imageInput: true,
      maskInput: false,
    },
    providerCost: (s) => 0.12 * (s.durationS ?? 5),
  },
  {
    id: 'seedance',
    name: 'Seedance 2.5',
    provider: 'ByteDance',
    logo: '/logos/bytedance.svg',
    kind: 'video',
    blurb: 'Seedance 2.5 — crisp clips with audio at fal prices.',
    capabilities: {
      aspectRatios: AR_VIDEO,
      resolutions: [
        { value: '480p', label: '480p', tooltip: 'Draft quality. $0.22/s.' },
        { value: '720p', label: '720p', tooltip: 'HD. $0.47/s.' },
      ],
      durations: [5, 10, 15],
      audio: 'included',
      modes: ['t2v', 'i2v', 'ref2v'],
      expectedSPerS: 20,
      imageInput: true,
      maskInput: false,
    },
    providerCost: (s) => (s.resolution === '480p' ? 0.2205 : 0.473) * (s.durationS ?? 5),
  },
```

Add these rate helpers directly ABOVE `export const MODEL_FAMILIES` (they must be declared before use at module load):

```ts
function veoRate(version: string | undefined, resolution: string | undefined): number {
  if (version === 'lite') return resolution === '1080p' ? 0.08 : 0.05;
  if (version === 'fast') {
    if (resolution === '4K') return 0.3;
    return resolution === '1080p' ? 0.12 : 0.1;
  }
  return resolution === '4K' ? 0.6 : 0.4;
}

function omniRate(resolution: string | undefined): number {
  if (resolution === '360p') return 0.03;
  if (resolution === '1080p') return 0.15;
  if (resolution === '4K') return 0.3;
  return 0.1;
}

function klingRate(audio: AudioMode | undefined): number {
  if (audio === 'voice') return 0.196;
  if (audio === 'on') return 0.168;
  return 0.112;
}
```

- [ ] **Step 5: Update `defaultSettings` and add `videoFamilySupports`**

Replace `defaultSettings`:

```ts
export function defaultSettings(family: ModelFamily): GenerationSettings {
  const c = family.capabilities;
  const defaultVersion = c.versions?.find((v) => v.tag === 'Latest') ?? c.versions?.[0];
  const base: GenerationSettings = {
    version: defaultVersion?.value,
    aspectRatio: c.aspectRatios[0],
    resolution: c.resolutions?.[0]?.value,
    quality: c.qualities ? 'medium' : undefined,
    durationS: c.durations?.[0],
    batch: 1,
  };
  if (family.kind !== 'video') return base;
  base.mode = 't2v';
  if (c.audio === 'selectable') base.audio = 'off';
  return base;
}

export function videoFamilySupports(family: ModelFamily, mode: VideoMode): boolean {
  return family.capabilities.modes?.includes(mode) ?? false;
}
```

- [ ] **Step 6: Run tests**

Run: `npm test -- --watch=false 2>&1 | tail -8`
Expected: `Tests  203 passed` (197 + 6). If `'every family has logo, blurb, and tooltips on every option'` fails, a `FamilyOption` is missing `tooltip` — fix it.

- [ ] **Step 7: Build**

Run: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npx ng build 2>&1 | tail -5`
Expected: build succeeds. `left-panel.html` still compiles because `capabilities.audio` is truthy-checked (fixed properly in Task 18).

User commits.

---

### Task 2: Sync shared catalog to Edge Functions

**Files:**
- Regenerate: `supabase/functions/_shared/model-families.ts` (via script)
- Test: `src/app/core/shared-sync.spec.ts` (existing drift guard)

**Interfaces:**
- Consumes: Task 1 catalog.
- Produces: Deno-side `familyById`, `creditCost`, `videoFamilySupports`, `VIDEO_DAILY_CAP_USD`, types `VideoMode`, `AudioMode`, `GenerationSettings` importable from `./_shared/model-families.ts` in `api/index.ts` and `../model-families.ts` inside `_shared/providers/`.

- [ ] **Step 1: Run the drift test — verify it fails**

Run: `npm test -- --watch=false 2>&1 | grep -E "shared-sync|Tests"`
Expected: `shared-sync.spec.ts` FAIL (model-families drifted).

- [ ] **Step 2: Sync**

Run: `npm run sync-shared`
Expected: prints the three regenerated files including `supabase/functions/_shared/model-families.ts`.

- [ ] **Step 3: Verify**

Run: `npm test -- --watch=false 2>&1 | tail -4`
Expected: `Tests  203 passed`.

Run: `grep -c "sora" supabase/functions/_shared/model-families.ts`
Expected: `0`.

Run: `cd supabase/functions && deno check _shared/model-families.ts && cd ../..`
Expected: no output (type-checks).

User commits.

---

### Task 3: Migration `0016_video.sql`

**Files:**
- Create: `supabase/migrations/0016_video.sql`

**Interfaces:**
- Produces columns used by Tasks 11–13: `generations.storage_backend`, `.duration_s`, `.width`, `.height`, `.thumb_path`; `jobs.claimed_at`, `.progress`, `.phase`; `jobs.provider` accepts `'runway'`; `models` rows `veo|omni|kling|runway|seedance` (`enabled=false`, `min_plan='pro'`).
- `attempts` already exists on `jobs` (0004) — do NOT add it.

- [ ] **Step 1: Write the migration**

```sql
-- 0016: video generation (spec 2026-09-05)
-- (applied YYYY-MM-DD via MCP apply_migration)

-- Generations: where the file lives + video metadata.
alter table public.generations
  add column if not exists storage_backend text not null default 'supabase'
    check (storage_backend in ('supabase', 'r2')),
  add column if not exists duration_s numeric(5,1),
  add column if not exists width int,
  add column if not exists height int,
  add column if not exists thumb_path text;

-- Jobs: runway provider, save-claim, live progress.
alter table public.jobs drop constraint if exists jobs_provider_check;
alter table public.jobs
  add constraint jobs_provider_check
    check (provider in ('google', 'openai', 'fal', 'runway'));

alter table public.jobs
  add column if not exists claimed_at timestamptz,
  add column if not exists progress numeric(4,3),
  add column if not exists phase text;

-- Kill-switch rows: video ships disabled, Pro-only. Sora is gone.
delete from public.models where id = 'sora';
insert into public.models (id, enabled, min_plan) values
  ('veo', false, 'pro'),
  ('omni', false, 'pro'),
  ('kling', false, 'pro'),
  ('runway', false, 'pro'),
  ('seedance', false, 'pro')
on conflict (id) do update set enabled = excluded.enabled, min_plan = excluded.min_plan;

-- Stale sweep: images 10 min (unchanged), videos 30 min. Also release
-- save-claims older than 10 min so a crashed finishJob can be retried.
select cron.unschedule('fail_stale_jobs');
select cron.schedule('fail_stale_jobs', '*/5 * * * *', $$
  update public.jobs set claimed_at = null
    where claimed_at is not null and claimed_at < now() - interval '10 minutes';
  select public.fn_fail_job(j.id, 'timeout')
    from public.jobs j
    join public.generations g on g.id = j.generation_id
    where g.status = 'pending'
      and j.error is null
      and j.created_at < now() - (
        case when g.kind = 'video' then interval '30 minutes' else interval '10 minutes' end
      );
$$);
```

- [ ] **Step 2: Apply via MCP**

Use the Supabase MCP `apply_migration` tool with `name: "0016_video"` and the file body. Then replace `YYYY-MM-DD` in the header comment with today's date.

- [ ] **Step 3: Verify**

Run via MCP `execute_sql`:

```sql
select id, enabled, min_plan from public.models where id in ('veo','omni','kling','runway','seedance','sora') order by id;
select column_name from information_schema.columns where table_name='jobs' and column_name in ('claimed_at','progress','phase','attempts');
select jobname, schedule from cron.job where jobname = 'fail_stale_jobs';
```

Expected: five rows enabled=false/min_plan=pro, no sora; four column rows; one cron row `*/5 * * * *`.

User commits.

---

### Task 4: Storage adapters (Supabase + Cloudflare R2)

**Files:**
- Create: `supabase/functions/_shared/storage/types.ts`
- Create: `supabase/functions/_shared/storage/supabase.ts`
- Create: `supabase/functions/_shared/storage/r2.ts`
- Create: `supabase/functions/_shared/storage/index.ts`
- Test: `supabase/functions/_shared/storage/r2_test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type StorageBackend = 'supabase' | 'r2';
  export interface StorageAdapter {
    readonly backend: StorageBackend;
    put(path: string, body: Uint8Array | ReadableStream<Uint8Array>, contentType: string): Promise<void>;
    signedUrl(path: string, ttlS: number): Promise<string>;
    delete(path: string): Promise<void>;
  }
  export function storageFor(backend: StorageBackend): StorageAdapter;
  export function r2ObjectUrl(path: string, env?: R2Env): string; // exported for tests
  ```
- Secrets: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`.
- Video paths: `videos/{userId}/{generationId}.mp4` and `.jpg` (thumb). Images stay in Supabase `media` bucket.

- [ ] **Step 1: Write the failing test**

`supabase/functions/_shared/storage/r2_test.ts`:

```ts
import { assertEquals, assertStringIncludes } from 'jsr:@std/assert';
import { r2ObjectUrl, r2PresignedGet } from './r2.ts';

const env = {
  accountId: 'acct123',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'secret',
  bucket: 'vansen-media',
};

Deno.test('r2ObjectUrl builds the S3-compatible object URL', () => {
  assertEquals(
    r2ObjectUrl('videos/u1/g1.mp4', env),
    'https://acct123.r2.cloudflarestorage.com/vansen-media/videos/u1/g1.mp4',
  );
});

Deno.test('r2PresignedGet returns a SigV4 query-signed URL with the requested TTL', async () => {
  const url = await r2PresignedGet('videos/u1/g1.mp4', 604800, env);
  assertStringIncludes(url, 'https://acct123.r2.cloudflarestorage.com/vansen-media/videos/u1/g1.mp4?');
  assertStringIncludes(url, 'X-Amz-Expires=604800');
  assertStringIncludes(url, 'X-Amz-Signature=');
  assertStringIncludes(url, 'X-Amz-Credential=AKIAEXAMPLE');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd supabase/functions && deno test --allow-all _shared/storage; cd ../..`
Expected: error `Module not found "./r2.ts"`.

- [ ] **Step 3: Write `types.ts`**

```ts
export type StorageBackend = 'supabase' | 'r2';

export interface StorageAdapter {
  readonly backend: StorageBackend;
  put(path: string, body: Uint8Array | ReadableStream<Uint8Array>, contentType: string): Promise<void>;
  signedUrl(path: string, ttlS: number): Promise<string>;
  delete(path: string): Promise<void>;
}
```

- [ ] **Step 4: Write `supabase.ts`**

```ts
import { createClient } from 'jsr:@supabase/supabase-js@2';
import type { StorageAdapter } from './types.ts';

const BUCKET = 'media';

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

async function toBytes(body: Uint8Array | ReadableStream<Uint8Array>): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  return new Uint8Array(await new Response(body).arrayBuffer());
}

export const supabaseStorage: StorageAdapter = {
  backend: 'supabase',
  async put(path, body, contentType) {
    const { error } = await admin.storage
      .from(BUCKET)
      .upload(path, await toBytes(body), { contentType, upsert: true });
    if (error) throw new Error(`supabase upload failed: ${error.message}`);
  },
  async signedUrl(path, ttlS) {
    const { data, error } = await admin.storage.from(BUCKET).createSignedUrl(path, ttlS);
    if (error || !data) throw new Error(`supabase sign failed: ${error?.message}`);
    return data.signedUrl;
  },
  async delete(path) {
    await admin.storage.from(BUCKET).remove([path]);
  },
};
```

- [ ] **Step 5: Write `r2.ts`**

```ts
import { AwsClient } from 'npm:aws4fetch@1.0.20';
import type { StorageAdapter } from './types.ts';

export interface R2Env {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

function envFromSecrets(): R2Env {
  const read = (k: string) => {
    const v = Deno.env.get(k);
    if (!v) throw new Error(`missing secret ${k}`);
    return v;
  };
  return {
    accountId: read('R2_ACCOUNT_ID'),
    accessKeyId: read('R2_ACCESS_KEY_ID'),
    secretAccessKey: read('R2_SECRET_ACCESS_KEY'),
    bucket: read('R2_BUCKET'),
  };
}

function clientFor(env: R2Env): AwsClient {
  return new AwsClient({
    accessKeyId: env.accessKeyId,
    secretAccessKey: env.secretAccessKey,
    service: 's3',
    region: 'auto',
  });
}

export function r2ObjectUrl(path: string, env: R2Env = envFromSecrets()): string {
  return `https://${env.accountId}.r2.cloudflarestorage.com/${env.bucket}/${path}`;
}

export async function r2PresignedGet(path: string, ttlS: number, env: R2Env = envFromSecrets()): Promise<string> {
  const url = new URL(r2ObjectUrl(path, env));
  url.searchParams.set('X-Amz-Expires', String(ttlS));
  const signed = await clientFor(env).sign(new Request(url, { method: 'GET' }), {
    aws: { signQuery: true },
  });
  return signed.url;
}

export const r2Storage: StorageAdapter = {
  backend: 'r2',
  async put(path, body, contentType) {
    const env = envFromSecrets();
    const res = await clientFor(env).fetch(r2ObjectUrl(path, env), {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body,
      // Required by fetch for streaming request bodies.
      ...(body instanceof Uint8Array ? {} : { duplex: 'half' }),
    } as RequestInit);
    if (!res.ok) throw new Error(`r2 put failed: ${res.status} ${await res.text()}`);
  },
  signedUrl(path, ttlS) {
    return r2PresignedGet(path, ttlS);
  },
  async delete(path) {
    const env = envFromSecrets();
    const res = await clientFor(env).fetch(r2ObjectUrl(path, env), { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new Error(`r2 delete failed: ${res.status}`);
  },
};
```

- [ ] **Step 6: Write `index.ts`**

```ts
import { r2Storage } from './r2.ts';
import { supabaseStorage } from './supabase.ts';
import type { StorageAdapter, StorageBackend } from './types.ts';

export type { StorageAdapter, StorageBackend } from './types.ts';

export function storageFor(backend: StorageBackend): StorageAdapter {
  return backend === 'r2' ? r2Storage : supabaseStorage;
}

export function videoPath(userId: string, generationId: string): string {
  return `videos/${userId}/${generationId}.mp4`;
}

export function thumbPath(userId: string, generationId: string): string {
  return `videos/${userId}/${generationId}.jpg`;
}
```

- [ ] **Step 7: Run tests**

Run: `cd supabase/functions && deno test --allow-all _shared; cd ../..`
Expected: `ok | 21 passed` (19 + 2). If aws4fetch's `signQuery` emits `X-Amz-Expires` differently, print `url` once and adjust the assertion to what SigV4 actually emits — the important assertions are `X-Amz-Signature=` and `X-Amz-Credential=AKIAEXAMPLE`.

User commits.

---

### Task 5: Provider types + Google Veo adapter

**Files:**
- Modify: `supabase/functions/_shared/providers/types.ts`
- Create: `supabase/functions/_shared/providers/google-video.ts`
- Create: `supabase/functions/_shared/providers/_test-fetch.ts` (test helper)
- Test: `supabase/functions/_shared/providers/google-video_test.ts`

**Interfaces:**
- Produces (types.ts, used by Tasks 6–13):
  ```ts
  export type ProviderName = 'google' | 'openai' | 'fal' | 'runway';
  export type JobPhase = 'queued' | 'rendering';
  export interface SubmitCtx {
    familyId: string; op: string; prompt: string; settings: Record<string, unknown>;
    referenceUrl?: string; maskPngBase64?: string; loraUrl?: string; safetyId: string;
    mode?: VideoMode; referenceUrls?: string[]; parentVideoUrl?: string; interactionId?: string;
  }
  export type CheckResult =
    | { state: 'running'; progress?: number; phase?: JobPhase; queuePosition?: number }
    | { state: 'done'; bytes: Uint8Array; contentType: string }
    | { state: 'done'; url: string; headers?: Record<string, string>; contentType: string;
        durationS?: number; width?: number; height?: number }
    | { state: 'failed'; error: string };
  export interface SubmitResult { providerRef: string; inline?: CheckResult; interactionId?: string }
  export interface ProviderAdapter {
    readonly provider: ProviderName;
    submit(ctx: SubmitCtx): Promise<SubmitResult>;
    check(providerRef: string): Promise<CheckResult>;
    cancel?(providerRef: string): Promise<void>;
  }
  export function isUrlResult(r: CheckResult): r is Extract<CheckResult, { url: string }>;
  ```
- Produces: `googleVideoAdapter: ProviderAdapter` (provider `'google'`, no `cancel`).
- Test helper: `stubFetch(handler): () => void` in `_test-fetch.ts`.

- [ ] **Step 1: Update `types.ts`**

Replace the file with:

```ts
import type { VideoMode } from '../model-families.ts';

export type ProviderName = 'google' | 'openai' | 'fal' | 'runway';
export type JobPhase = 'queued' | 'rendering';

export interface SubmitCtx {
  familyId: string;
  op: string;
  prompt: string;
  settings: Record<string, unknown>;
  referenceUrl?: string;
  maskPngBase64?: string;
  loraUrl?: string;
  safetyId: string;
  /** Video only. */
  mode?: VideoMode;
  /** Signed URLs (1 h). ref2v: 1–3 refs; keyframes: [first, last]. */
  referenceUrls?: string[];
  /** Signed URL of the parent video for extend/edit. */
  parentVideoUrl?: string;
  /** Omni conversation id for extend/edit. */
  interactionId?: string;
}

export type CheckResult =
  | { state: 'running'; progress?: number; phase?: JobPhase; queuePosition?: number }
  | { state: 'done'; bytes: Uint8Array; contentType: string }
  | {
      state: 'done';
      url: string;
      headers?: Record<string, string>;
      contentType: string;
      durationS?: number;
      width?: number;
      height?: number;
    }
  | { state: 'failed'; error: string };

export interface SubmitResult {
  providerRef: string;
  inline?: CheckResult;
  /** Omni only: conversation id persisted into generation settings. */
  interactionId?: string;
}

export interface ProviderAdapter {
  readonly provider: ProviderName;
  submit(ctx: SubmitCtx): Promise<SubmitResult>;
  check(providerRef: string): Promise<CheckResult>;
  /** Optional. Providers that cannot cancel omit it (Veo, Omni). */
  cancel?(providerRef: string): Promise<void>;
}

export function isUrlResult(r: CheckResult): r is Extract<CheckResult, { url: string }> {
  return r.state === 'done' && 'url' in r;
}

export async function fetchBytes(url: string, init?: RequestInit): Promise<Uint8Array> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`fetch ${res.status} for ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}
```

(If the existing `fetchBytes` differs, keep the existing body — only the types above matter.)

- [ ] **Step 2: Write the test helper `_test-fetch.ts`**

```ts
export type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;

/** Replace globalThis.fetch for one test. Returns restore fn. */
export function stubFetch(handler: FetchHandler): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(input instanceof Request ? input.url : input), init))) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
```

- [ ] **Step 3: Write the failing test `google-video_test.ts`**

```ts
import { assertEquals, assertRejects } from 'jsr:@std/assert';
import { googleVideoAdapter, veoModelFor } from './google-video.ts';
import { json, stubFetch } from './_test-fetch.ts';

Deno.env.set('GOOGLE_AI_API_KEY', 'test-key');

Deno.test('veoModelFor maps version to model id', () => {
  assertEquals(veoModelFor('standard'), 'veo-3.1-generate-preview');
  assertEquals(veoModelFor('fast'), 'veo-3.1-fast-generate-preview');
  assertEquals(veoModelFor('lite'), 'veo-3.1-lite-generate-preview');
  assertEquals(veoModelFor(undefined), 'veo-3.1-generate-preview');
});

Deno.test('submit posts predictLongRunning and returns the operation name', async () => {
  const calls: { url: string; body: unknown }[] = [];
  const restore = stubFetch((url, init) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    return json({ name: 'models/veo-3.1-generate-preview/operations/op123' });
  });
  try {
    const r = await googleVideoAdapter.submit({
      familyId: 'veo', op: 'generate', prompt: 'a fox', safetyId: 's',
      settings: { aspectRatio: '9:16', resolution: '1080p', durationS: 6, version: 'standard' },
      mode: 't2v',
    });
    assertEquals(r.providerRef, 'models/veo-3.1-generate-preview/operations/op123');
    assertEquals(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-generate-preview:predictLongRunning');
    const body = calls[0].body as { instances: { prompt: string }[]; parameters: Record<string, unknown> };
    assertEquals(body.instances[0].prompt, 'a fox');
    assertEquals(body.parameters.aspectRatio, '9:16');
    assertEquals(body.parameters.resolution, '1080p');
    assertEquals(body.parameters.durationSeconds, 6);
  } finally {
    restore();
  }
});

Deno.test('submit rejects unsupported mode before any network call', async () => {
  const restore = stubFetch(() => {
    throw new Error('should not fetch');
  });
  try {
    await assertRejects(
      () => googleVideoAdapter.submit({ familyId: 'veo', op: 'generate', prompt: 'x', safetyId: 's', settings: {}, mode: 'edit' }),
      Error,
      'unsupported_mode',
    );
  } finally {
    restore();
  }
});

Deno.test('check maps running / done-url / failed', async () => {
  let restore = stubFetch(() => json({ name: 'op', done: false }));
  try {
    assertEquals(await googleVideoAdapter.check('models/x/operations/op'), { state: 'running', phase: 'rendering' });
  } finally {
    restore();
  }
  restore = stubFetch(() =>
    json({
      name: 'op', done: true,
      response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://files/v.mp4' } }] } },
    }));
  try {
    const r = await googleVideoAdapter.check('models/x/operations/op');
    assertEquals(r, {
      state: 'done', url: 'https://files/v.mp4', contentType: 'video/mp4',
      headers: { 'x-goog-api-key': 'test-key' },
    });
  } finally {
    restore();
  }
  restore = stubFetch(() => json({ name: 'op', done: true, error: { message: 'blocked by safety' } }));
  try {
    assertEquals(await googleVideoAdapter.check('models/x/operations/op'), { state: 'failed', error: 'provider_blocked' });
  } finally {
    restore();
  }
  restore = stubFetch(() =>
    json({ name: 'op', done: true, response: { generateVideoResponse: { raiMediaFilteredCount: 1, generatedSamples: [] } } }));
  try {
    assertEquals(await googleVideoAdapter.check('models/x/operations/op'), { state: 'failed', error: 'provider_blocked' });
  } finally {
    restore();
  }
});
```

- [ ] **Step 4: Run to verify failure**

Run: `cd supabase/functions && deno test --allow-all _shared/providers/google-video_test.ts; cd ../..`
Expected: `Module not found "./google-video.ts"`.

- [ ] **Step 5: Write `google-video.ts`**

```ts
import { encodeBase64 } from 'jsr:@std/encoding/base64';
import type { CheckResult, ProviderAdapter, SubmitCtx, SubmitResult } from './types.ts';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const SUPPORTED = new Set(['t2v', 'i2v', 'ref2v', 'keyframes', 'extend']);

function key(): string {
  const k = Deno.env.get('GOOGLE_AI_API_KEY');
  if (!k) throw new Error('GOOGLE_AI_API_KEY not set');
  return k;
}

function headers(): Record<string, string> {
  return { 'x-goog-api-key': key(), 'Content-Type': 'application/json' };
}

export function veoModelFor(version: unknown): string {
  if (version === 'fast') return 'veo-3.1-fast-generate-preview';
  if (version === 'lite') return 'veo-3.1-lite-generate-preview';
  return 'veo-3.1-generate-preview';
}

interface InlineMedia {
  bytesBase64Encoded: string;
  mimeType: string;
}

async function inlineMedia(url: string, fallbackMime: string): Promise<InlineMedia> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`reference fetch ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return {
    bytesBase64Encoded: encodeBase64(bytes),
    mimeType: res.headers.get('content-type')?.split(';')[0] ?? fallbackMime,
  };
}

async function instanceFor(ctx: SubmitCtx): Promise<Record<string, unknown>> {
  const instance: Record<string, unknown> = { prompt: ctx.prompt };
  const refs = ctx.referenceUrls ?? [];
  const mode = ctx.mode ?? 't2v';
  if (mode === 'i2v' && refs[0]) instance.image = await inlineMedia(refs[0], 'image/png');
  if (mode === 'keyframes' && refs[0]) instance.image = await inlineMedia(refs[0], 'image/png');
  if (mode === 'keyframes' && refs[1]) instance.lastFrame = await inlineMedia(refs[1], 'image/png');
  if (mode === 'ref2v' && refs.length > 0) {
    instance.referenceImages = await Promise.all(
      refs.slice(0, 3).map(async (u) => ({ image: await inlineMedia(u, 'image/png'), referenceType: 'asset' })),
    );
  }
  if (mode === 'extend' && ctx.parentVideoUrl) instance.video = await inlineMedia(ctx.parentVideoUrl, 'video/mp4');
  return instance;
}

function parametersFor(ctx: SubmitCtx): Record<string, unknown> {
  const s = ctx.settings;
  return {
    aspectRatio: s.aspectRatio ?? '16:9',
    resolution: s.resolution ?? '1080p',
    durationSeconds: typeof s.durationS === 'number' ? s.durationS : 8,
    personGeneration: 'allow_adult',
  };
}

function isBlocked(op: Record<string, unknown>): boolean {
  const err = op.error as { message?: string } | undefined;
  if (err) return true;
  const resp = (op.response as { generateVideoResponse?: Record<string, unknown> } | undefined)?.generateVideoResponse;
  if (!resp) return true;
  const samples = (resp.generatedSamples as unknown[] | undefined) ?? [];
  return samples.length === 0;
}

export const googleVideoAdapter: ProviderAdapter = {
  provider: 'google',

  async submit(ctx: SubmitCtx): Promise<SubmitResult> {
    const mode = ctx.mode ?? 't2v';
    if (!SUPPORTED.has(mode)) throw new Error('unsupported_mode');
    const model = veoModelFor(ctx.settings.version);
    const body = { instances: [await instanceFor(ctx)], parameters: parametersFor(ctx) };
    const res = await fetch(`${API_BASE}/models/${model}:predictLongRunning`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`veo submit ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { name?: string };
    if (!data.name) throw new Error('veo submit: missing operation name');
    return { providerRef: data.name };
  },

  async check(providerRef: string): Promise<CheckResult> {
    if (!/^models\/[\w.-]+\/operations\/[\w-]+$/.test(providerRef)) {
      return { state: 'failed', error: 'bad_provider_ref' };
    }
    const res = await fetch(`${API_BASE}/${providerRef}`, { headers: headers() });
    if (!res.ok) throw new Error(`veo poll ${res.status}`);
    const op = (await res.json()) as Record<string, unknown>;
    if (!op.done) return { state: 'running', phase: 'rendering' };
    if (isBlocked(op)) return { state: 'failed', error: 'provider_blocked' };
    const resp = (op.response as { generateVideoResponse: { generatedSamples: { video: { uri: string } }[] } })
      .generateVideoResponse;
    return {
      state: 'done',
      url: resp.generatedSamples[0].video.uri,
      contentType: 'video/mp4',
      headers: { 'x-goog-api-key': key() },
    };
  },
};
```

- [ ] **Step 6: Run tests**

Run: `cd supabase/functions && deno test --allow-all _shared; cd ../..`
Expected: `ok | 25 passed` (21 + 4).

User commits.

---

### Task 6: Google Omni (Interactions API) adapter

**Files:**
- Create: `supabase/functions/_shared/providers/google-omni.ts`
- Test: `supabase/functions/_shared/providers/google-omni_test.ts`

**Interfaces:**
- Consumes: `types.ts` from Task 5, `_test-fetch.ts`.
- Produces: `googleOmniAdapter: ProviderAdapter` (provider `'google'`, no cancel). `submit` returns `interactionId` = the interaction id so Task 11 can persist it into `generations.settings.interactionId`; extend/edit pass `ctx.interactionId` as `previous_interaction_id`.

- [ ] **Step 1: Write the failing test**

```ts
import { assertEquals } from 'jsr:@std/assert';
import { googleOmniAdapter } from './google-omni.ts';
import { json, stubFetch } from './_test-fetch.ts';

Deno.env.set('GOOGLE_AI_API_KEY', 'test-key');

Deno.test('submit creates a background interaction and returns its id', async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const restore = stubFetch((url, init) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    return json({ id: 'int_abc', status: 'in_progress' });
  });
  try {
    const r = await googleOmniAdapter.submit({
      familyId: 'omni', op: 'generate', prompt: 'a cat', safetyId: 's',
      settings: { aspectRatio: '1:1', resolution: '720p', durationS: 4 }, mode: 't2v',
    });
    assertEquals(r.providerRef, 'int_abc');
    assertEquals(r.interactionId, 'int_abc');
    assertEquals(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
    assertEquals(calls[0].body.model, 'gemini-omni-flash-1.1');
    assertEquals(calls[0].body.background, true);
    assertEquals((calls[0].body.generation_config as { video_config: Record<string, unknown> }).video_config, {
      aspect_ratio: '1:1', resolution: '720p', duration_seconds: 4,
    });
    assertEquals(calls[0].body.previous_interaction_id, undefined);
  } finally {
    restore();
  }
});

Deno.test('edit passes previous_interaction_id', async () => {
  let body: Record<string, unknown> = {};
  const restore = stubFetch((_url, init) => {
    body = JSON.parse(String(init?.body));
    return json({ id: 'int_2', status: 'in_progress' });
  });
  try {
    await googleOmniAdapter.submit({
      familyId: 'omni', op: 'generate', prompt: 'make it night', safetyId: 's',
      settings: { aspectRatio: '16:9' }, mode: 'edit', interactionId: 'int_abc',
    });
    assertEquals(body.previous_interaction_id, 'int_abc');
  } finally {
    restore();
  }
});

Deno.test('check maps in_progress / completed / failed', async () => {
  let restore = stubFetch(() => json({ id: 'int_abc', status: 'in_progress' }));
  try {
    assertEquals(await googleOmniAdapter.check('int_abc'), { state: 'running', phase: 'rendering' });
  } finally {
    restore();
  }
  restore = stubFetch(() =>
    json({ id: 'int_abc', status: 'completed', outputs: [{ type: 'video', uri: 'https://files/o.mp4', mime_type: 'video/mp4' }] }));
  try {
    assertEquals(await googleOmniAdapter.check('int_abc'), {
      state: 'done', url: 'https://files/o.mp4', contentType: 'video/mp4', headers: { 'x-goog-api-key': 'test-key' },
    });
  } finally {
    restore();
  }
  restore = stubFetch(() => json({ id: 'int_abc', status: 'failed', error: { code: 'SAFETY', message: 'nope' } }));
  try {
    assertEquals(await googleOmniAdapter.check('int_abc'), { state: 'failed', error: 'provider_blocked' });
  } finally {
    restore();
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd supabase/functions && deno test --allow-all _shared/providers/google-omni_test.ts; cd ../..`
Expected: `Module not found "./google-omni.ts"`.

- [ ] **Step 3: Write `google-omni.ts`**

```ts
import type { CheckResult, ProviderAdapter, SubmitCtx, SubmitResult } from './types.ts';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MODEL = 'gemini-omni-flash-1.1';

function key(): string {
  const k = Deno.env.get('GOOGLE_AI_API_KEY');
  if (!k) throw new Error('GOOGLE_AI_API_KEY not set');
  return k;
}

function headers(): Record<string, string> {
  return { 'x-goog-api-key': key(), 'Content-Type': 'application/json' };
}

type InputPart = { type: 'text'; text: string } | { type: 'image' | 'video'; uri: string };

function inputFor(ctx: SubmitCtx): InputPart[] {
  const parts: InputPart[] = [{ type: 'text', text: ctx.prompt }];
  for (const u of ctx.referenceUrls ?? []) parts.push({ type: 'image', uri: u });
  const needsParent = (ctx.mode === 'extend' || ctx.mode === 'edit') && !ctx.interactionId;
  if (needsParent && ctx.parentVideoUrl) parts.push({ type: 'video', uri: ctx.parentVideoUrl });
  return parts;
}

function isSafetyFailure(err: { code?: string; message?: string } | undefined): boolean {
  if (!err) return false;
  const text = `${err.code ?? ''} ${err.message ?? ''}`.toLowerCase();
  return text.includes('safety') || text.includes('blocked') || text.includes('policy');
}

export const googleOmniAdapter: ProviderAdapter = {
  provider: 'google',

  async submit(ctx: SubmitCtx): Promise<SubmitResult> {
    const s = ctx.settings;
    const body: Record<string, unknown> = {
      model: MODEL,
      background: true,
      input: inputFor(ctx),
      generation_config: {
        video_config: {
          aspect_ratio: s.aspectRatio ?? '16:9',
          resolution: s.resolution ?? '720p',
          duration_seconds: typeof s.durationS === 'number' ? s.durationS : 8,
        },
      },
    };
    if (ctx.interactionId) body.previous_interaction_id = ctx.interactionId;
    const res = await fetch(`${API_BASE}/interactions`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`omni submit ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { id?: string };
    if (!data.id) throw new Error('omni submit: missing interaction id');
    return { providerRef: data.id, interactionId: data.id };
  },

  async check(providerRef: string): Promise<CheckResult> {
    if (!/^[\w-]+$/.test(providerRef)) return { state: 'failed', error: 'bad_provider_ref' };
    const res = await fetch(`${API_BASE}/interactions/${providerRef}`, { headers: headers() });
    if (!res.ok) throw new Error(`omni poll ${res.status}`);
    const data = (await res.json()) as {
      status: string;
      outputs?: { type: string; uri?: string; mime_type?: string }[];
      error?: { code?: string; message?: string };
    };
    if (data.status === 'in_progress' || data.status === 'queued') return { state: 'running', phase: 'rendering' };
    if (data.status !== 'completed') {
      return { state: 'failed', error: isSafetyFailure(data.error) ? 'provider_blocked' : 'provider_failed' };
    }
    const video = data.outputs?.find((o) => o.type === 'video' && o.uri);
    if (!video?.uri) return { state: 'failed', error: 'provider_blocked' };
    return {
      state: 'done',
      url: video.uri,
      contentType: video.mime_type ?? 'video/mp4',
      headers: { 'x-goog-api-key': key() },
    };
  },
};
```

- [ ] **Step 4: Run tests**

Run: `cd supabase/functions && deno test --allow-all _shared; cd ../..`
Expected: `ok | 28 passed` (25 + 3).

User commits.

---

### Task 7: Runway Gen-4.5 adapter

**Files:**
- Create: `supabase/functions/_shared/providers/runway.ts`
- Test: `supabase/functions/_shared/providers/runway_test.ts`

**Interfaces:**
- Consumes: `types.ts`, `_test-fetch.ts`.
- Produces: `runwayAdapter: ProviderAdapter` with `provider: 'runway'` and `cancel(providerRef)`. Secret `RUNWAY_API_KEY`. `runwayRatio(aspectRatio, resolution)` exported for tests.

- [ ] **Step 1: Write the failing test**

```ts
import { assertEquals } from 'jsr:@std/assert';
import { runwayAdapter, runwayRatio } from './runway.ts';
import { json, stubFetch } from './_test-fetch.ts';

Deno.env.set('RUNWAY_API_KEY', 'rw-test');

Deno.test('runwayRatio maps aspect + resolution', () => {
  assertEquals(runwayRatio('16:9', '720p'), '1280:720');
  assertEquals(runwayRatio('16:9', '1080p'), '1920:1080');
  assertEquals(runwayRatio('9:16', '1080p'), '1080:1920');
  assertEquals(runwayRatio('1:1', '720p'), '960:960');
  assertEquals(runwayRatio('1:1', '1080p'), '1080:1080');
});

Deno.test('submit picks text_to_video or image_to_video by mode', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const restore = stubFetch((url, init) => {
    calls.push({ url, init: init! });
    return json({ id: 'task_1' });
  });
  try {
    const r = await runwayAdapter.submit({
      familyId: 'runway', op: 'generate', prompt: 'drone shot', safetyId: 's',
      settings: { aspectRatio: '16:9', resolution: '1080p', durationS: 10 }, mode: 't2v',
    });
    assertEquals(r.providerRef, 'task_1');
    assertEquals(calls[0].url, 'https://api.dev.runwayml.com/v1/text_to_video');
    const h = calls[0].init.headers as Record<string, string>;
    assertEquals(h['X-Runway-Version'], '2024-11-06');
    assertEquals(h.Authorization, 'Bearer rw-test');
    assertEquals(JSON.parse(String(calls[0].init.body)), {
      model: 'gen4.5', promptText: 'drone shot', ratio: '1920:1080', duration: 10,
    });

    await runwayAdapter.submit({
      familyId: 'runway', op: 'generate', prompt: 'animate', safetyId: 's',
      settings: { aspectRatio: '9:16', resolution: '720p', durationS: 5 }, mode: 'i2v',
      referenceUrls: ['https://signed/ref.png'],
    });
    assertEquals(calls[1].url, 'https://api.dev.runwayml.com/v1/image_to_video');
    assertEquals(JSON.parse(String(calls[1].init.body)).promptImage, 'https://signed/ref.png');
  } finally {
    restore();
  }
});

Deno.test('check maps task states and progress', async () => {
  let restore = stubFetch(() => json({ id: 'task_1', status: 'PENDING' }));
  try {
    assertEquals(await runwayAdapter.check('task_1'), { state: 'running', phase: 'queued' });
  } finally {
    restore();
  }
  restore = stubFetch(() => json({ id: 'task_1', status: 'RUNNING', progress: 0.42 }));
  try {
    assertEquals(await runwayAdapter.check('task_1'), { state: 'running', phase: 'rendering', progress: 0.42 });
  } finally {
    restore();
  }
  restore = stubFetch(() => json({ id: 'task_1', status: 'SUCCEEDED', output: ['https://cdn/out.mp4'] }));
  try {
    assertEquals(await runwayAdapter.check('task_1'), { state: 'done', url: 'https://cdn/out.mp4', contentType: 'video/mp4' });
  } finally {
    restore();
  }
  restore = stubFetch(() => json({ id: 'task_1', status: 'FAILED', failureCode: 'SAFETY.INPUT.TEXT', failure: 'moderation' }));
  try {
    assertEquals(await runwayAdapter.check('task_1'), { state: 'failed', error: 'provider_blocked' });
  } finally {
    restore();
  }
});

Deno.test('cancel issues DELETE /v1/tasks/:id', async () => {
  let seen = '';
  const restore = stubFetch((url, init) => {
    seen = `${init?.method} ${url}`;
    return new Response(null, { status: 204 });
  });
  try {
    await runwayAdapter.cancel!('task_1');
    assertEquals(seen, 'DELETE https://api.dev.runwayml.com/v1/tasks/task_1');
  } finally {
    restore();
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd supabase/functions && deno test --allow-all _shared/providers/runway_test.ts; cd ../..`
Expected: `Module not found "./runway.ts"`.

- [ ] **Step 3: Write `runway.ts`**

```ts
import type { CheckResult, ProviderAdapter, SubmitCtx, SubmitResult } from './types.ts';

const API_BASE = 'https://api.dev.runwayml.com/v1';
const API_VERSION = '2024-11-06';
const MODEL = 'gen4.5';

function key(): string {
  const k = Deno.env.get('RUNWAY_API_KEY');
  if (!k) throw new Error('RUNWAY_API_KEY not set');
  return k;
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${key()}`,
    'X-Runway-Version': API_VERSION,
    'Content-Type': 'application/json',
  };
}

const RATIOS: Record<string, Record<string, string>> = {
  '16:9': { '720p': '1280:720', '1080p': '1920:1080' },
  '9:16': { '720p': '720:1280', '1080p': '1080:1920' },
  '1:1': { '720p': '960:960', '1080p': '1080:1080' },
};

export function runwayRatio(aspectRatio: unknown, resolution: unknown): string {
  const byRes = RATIOS[String(aspectRatio)] ?? RATIOS['16:9'];
  return byRes[String(resolution)] ?? byRes['720p'];
}

function isBlocked(code: string | undefined, message: string | undefined): boolean {
  const text = `${code ?? ''} ${message ?? ''}`.toUpperCase();
  return text.includes('SAFETY') || text.includes('MODERATION');
}

export const runwayAdapter: ProviderAdapter = {
  provider: 'runway',

  async submit(ctx: SubmitCtx): Promise<SubmitResult> {
    const mode = ctx.mode ?? 't2v';
    if (mode !== 't2v' && mode !== 'i2v') throw new Error('unsupported_mode');
    const s = ctx.settings;
    const body: Record<string, unknown> = {
      model: MODEL,
      promptText: ctx.prompt,
      ratio: runwayRatio(s.aspectRatio, s.resolution),
      duration: typeof s.durationS === 'number' ? s.durationS : 5,
    };
    let endpoint = 'text_to_video';
    if (mode === 'i2v') {
      const ref = ctx.referenceUrls?.[0];
      if (!ref) throw new Error('missing_reference');
      body.promptImage = ref;
      endpoint = 'image_to_video';
    }
    const res = await fetch(`${API_BASE}/${endpoint}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`runway submit ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { id?: string };
    if (!data.id) throw new Error('runway submit: missing task id');
    return { providerRef: data.id };
  },

  async check(providerRef: string): Promise<CheckResult> {
    if (!/^[\w-]+$/.test(providerRef)) return { state: 'failed', error: 'bad_provider_ref' };
    const res = await fetch(`${API_BASE}/tasks/${providerRef}`, { headers: headers() });
    if (!res.ok) throw new Error(`runway poll ${res.status}`);
    const t = (await res.json()) as {
      status: string;
      progress?: number;
      output?: string[];
      failure?: string;
      failureCode?: string;
    };
    if (t.status === 'PENDING' || t.status === 'THROTTLED') return { state: 'running', phase: 'queued' };
    if (t.status === 'RUNNING') {
      const running: CheckResult = { state: 'running', phase: 'rendering' };
      if (typeof t.progress === 'number') running.progress = t.progress;
      return running;
    }
    if (t.status === 'SUCCEEDED' && t.output?.[0]) {
      return { state: 'done', url: t.output[0], contentType: 'video/mp4' };
    }
    if (t.status === 'CANCELLED') return { state: 'failed', error: 'cancelled' };
    return { state: 'failed', error: isBlocked(t.failureCode, t.failure) ? 'provider_blocked' : 'provider_failed' };
  },

  async cancel(providerRef: string): Promise<void> {
    if (!/^[\w-]+$/.test(providerRef)) return;
    await fetch(`${API_BASE}/tasks/${providerRef}`, { method: 'DELETE', headers: headers() });
  },
};
```

- [ ] **Step 4: Run tests**

Run: `cd supabase/functions && deno test --allow-all _shared; cd ../..`
Expected: `ok | 32 passed` (28 + 4).

User commits.

---

### Task 8: fal adapter — Kling 3.0 Pro + Seedance 2.5, video results, cancel

**Files:**
- Modify: `supabase/functions/_shared/providers/fal.ts` (`slugFor`, `payloadFor`, `check`, new `cancel`)
- Test: `supabase/functions/_shared/providers/fal_test.ts`

**Interfaces:**
- Consumes: `types.ts` (Task 5).
- Produces: `falAdapter.cancel(providerRef)`; exported pure helpers `videoSlugFor(ctx): string` and `videoPayloadFor(ctx): Record<string, unknown>`; `check` returns `{ state:'done', url, contentType:'video/mp4' }` for video results and `queuePosition` while `IN_QUEUE`.

- [ ] **Step 1: Write the failing test**

```ts
import { assertEquals, assertThrows } from 'jsr:@std/assert';
import { falAdapter, videoPayloadFor, videoSlugFor } from './fal.ts';
import { json, stubFetch } from './_test-fetch.ts';

Deno.env.set('FAL_API_KEY', 'fal-test');

const base = { op: 'generate', prompt: 'surf', safetyId: 's' };

Deno.test('kling slugs and payload', () => {
  const t2v = { ...base, familyId: 'kling', settings: { aspectRatio: '16:9', durationS: 10, audio: 'on' }, mode: 't2v' as const };
  assertEquals(videoSlugFor(t2v), 'fal-ai/kling-video/v3/pro/text-to-video');
  assertEquals(videoPayloadFor(t2v), { prompt: 'surf', duration: '10', aspect_ratio: '16:9', generate_audio: true, voice: false });

  const i2v = { ...t2v, mode: 'i2v' as const, referenceUrls: ['https://s/a.png'], settings: { ...t2v.settings, audio: 'voice' } };
  assertEquals(videoSlugFor(i2v), 'fal-ai/kling-video/v3/pro/image-to-video');
  assertEquals(videoPayloadFor(i2v), { prompt: 'surf', duration: '10', image_url: 'https://s/a.png', generate_audio: true, voice: true });

  const kf = { ...i2v, mode: 'keyframes' as const, referenceUrls: ['https://s/a.png', 'https://s/b.png'] };
  assertEquals(videoPayloadFor(kf).tail_image_url, 'https://s/b.png');
  assertThrows(() => videoSlugFor({ ...t2v, mode: 'ref2v' }), Error, 'unsupported_mode');
});

Deno.test('seedance slugs and payload', () => {
  const t2v = { ...base, familyId: 'seedance', settings: { aspectRatio: '9:16', resolution: '480p', durationS: 5 }, mode: 't2v' as const };
  assertEquals(videoSlugFor(t2v), 'bytedance/seedance-2.5/text-to-video');
  assertEquals(videoPayloadFor(t2v), { prompt: 'surf', duration: '5', aspect_ratio: '9:16', resolution: '480p' });
  const ref = { ...t2v, mode: 'ref2v' as const, referenceUrls: ['https://s/a.png', 'https://s/b.png'] };
  assertEquals(videoSlugFor(ref), 'bytedance/seedance-2.5/reference-to-video');
  assertEquals(videoPayloadFor(ref).reference_image_urls, ['https://s/a.png', 'https://s/b.png']);
  assertThrows(() => videoSlugFor({ ...t2v, mode: 'keyframes' }), Error, 'unsupported_mode');
});

Deno.test('check surfaces queue position and video url', async () => {
  const ref = JSON.stringify({
    statusUrl: 'https://queue.fal.run/fal-ai/kling-video/requests/r1/status',
    responseUrl: 'https://queue.fal.run/fal-ai/kling-video/requests/r1',
  });
  let restore = stubFetch(() => json({ status: 'IN_QUEUE', queue_position: 3 }));
  try {
    assertEquals(await falAdapter.check(ref), { state: 'running', phase: 'queued', queuePosition: 3 });
  } finally {
    restore();
  }
  restore = stubFetch((url) =>
    url.endsWith('/status') ? json({ status: 'COMPLETED' }) : json({ video: { url: 'https://v3.fal.media/x.mp4' } }));
  try {
    assertEquals(await falAdapter.check(ref), { state: 'done', url: 'https://v3.fal.media/x.mp4', contentType: 'video/mp4' });
  } finally {
    restore();
  }
});

Deno.test('cancel PUTs the cancel endpoint only while queued', async () => {
  const ref = JSON.stringify({
    statusUrl: 'https://queue.fal.run/fal-ai/kling-video/requests/r1/status',
    responseUrl: 'https://queue.fal.run/fal-ai/kling-video/requests/r1',
  });
  const seen: string[] = [];
  let restore = stubFetch((url, init) => {
    seen.push(`${init?.method ?? 'GET'} ${url}`);
    return json({ status: 'IN_QUEUE' });
  });
  try {
    await falAdapter.cancel!(ref);
    assertEquals(seen[1], 'PUT https://queue.fal.run/fal-ai/kling-video/requests/r1/cancel');
  } finally {
    restore();
  }
  seen.length = 0;
  restore = stubFetch((url, init) => {
    seen.push(`${init?.method ?? 'GET'} ${url}`);
    return json({ status: 'IN_PROGRESS' });
  });
  try {
    await falAdapter.cancel!(ref);
    assertEquals(seen.length, 1);
  } finally {
    restore();
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd supabase/functions && deno test --allow-all _shared/providers/fal_test.ts; cd ../..`
Expected: `videoSlugFor` has no exported member.

- [ ] **Step 3: Add video slug/payload helpers to `fal.ts`**

Insert above the existing `slugFor`:

```ts
const VIDEO_FAMILIES = new Set(['kling', 'seedance']);

const KLING_SLUGS: Partial<Record<string, string>> = {
  t2v: 'fal-ai/kling-video/v3/pro/text-to-video',
  i2v: 'fal-ai/kling-video/v3/pro/image-to-video',
  keyframes: 'fal-ai/kling-video/v3/pro/image-to-video',
};

const SEEDANCE_SLUGS: Partial<Record<string, string>> = {
  t2v: 'bytedance/seedance-2.5/text-to-video',
  i2v: 'bytedance/seedance-2.5/image-to-video',
  ref2v: 'bytedance/seedance-2.5/reference-to-video',
};

export function videoSlugFor(ctx: SubmitCtx): string {
  const mode = ctx.mode ?? 't2v';
  const table = ctx.familyId === 'kling' ? KLING_SLUGS : SEEDANCE_SLUGS;
  const slug = table[mode];
  if (!slug) throw new Error('unsupported_mode');
  return slug;
}

export function videoPayloadFor(ctx: SubmitCtx): Record<string, unknown> {
  const s = ctx.settings;
  const mode = ctx.mode ?? 't2v';
  const refs = ctx.referenceUrls ?? [];
  const payload: Record<string, unknown> = {
    prompt: ctx.prompt,
    duration: String(typeof s.durationS === 'number' ? s.durationS : 5),
  };
  if (mode === 't2v') payload.aspect_ratio = s.aspectRatio ?? '16:9';
  if (mode === 'i2v' || mode === 'keyframes') payload.image_url = refs[0];
  if (mode === 'keyframes' && refs[1]) payload.tail_image_url = refs[1];
  if (mode === 'ref2v') payload.reference_image_urls = refs.slice(0, 3);
  if (ctx.familyId === 'kling') {
    payload.generate_audio = s.audio === 'on' || s.audio === 'voice';
    payload.voice = s.audio === 'voice';
  }
  if (ctx.familyId === 'seedance') payload.resolution = s.resolution ?? '720p';
  return payload;
}
```

Then add guard clauses as the FIRST line of the existing functions:

```ts
function slugFor(ctx: SubmitCtx): string {
  if (VIDEO_FAMILIES.has(ctx.familyId)) return videoSlugFor(ctx);
  // …existing image branches unchanged…
}

function payloadFor(ctx: SubmitCtx): Record<string, unknown> {
  if (VIDEO_FAMILIES.has(ctx.familyId)) return videoPayloadFor(ctx);
  // …existing image branches unchanged…
}
```

Note: `fal-ai/kling-video/v3/pro/*` field names `generate_audio`/`voice` and `bytedance/seedance-2.5/*` `resolution`/`reference_image_urls` are per fal's schema at spec time. Confirm against `https://fal.ai/models/<slug>/api` during the Task 24 smoke and adjust `videoPayloadFor` (tests included) if fal renamed a field.

- [ ] **Step 4: Replace `falAdapter.check` and add `cancel`**

```ts
  async check(providerRef: string): Promise<CheckResult> {
    const ref = JSON.parse(providerRef) as { statusUrl: string; responseUrl: string };
    if (!ref.statusUrl.startsWith(FAL_BASE) || !ref.responseUrl.startsWith(FAL_BASE)) {
      return { state: 'failed', error: 'bad_provider_ref' };
    }
    const statusRes = await fetch(ref.statusUrl, { headers: await auth() });
    if (!statusRes.ok) throw new Error(`fal status ${statusRes.status}`);
    const status = (await statusRes.json()) as { status: string; queue_position?: number; error?: string };
    if (status.status === 'IN_QUEUE') {
      const running: CheckResult = { state: 'running', phase: 'queued' };
      if (typeof status.queue_position === 'number') running.queuePosition = status.queue_position;
      return running;
    }
    if (status.status === 'IN_PROGRESS') return { state: 'running', phase: 'rendering' };
    if (status.status !== 'COMPLETED') {
      return { state: 'failed', error: String(status.error ?? status.status).slice(0, 200) };
    }
    const resultRes = await fetch(ref.responseUrl, { headers: await auth() });
    if (!resultRes.ok) throw new Error(`fal result ${resultRes.status}`);
    const result = (await resultRes.json()) as {
      images?: { url: string }[];
      image?: { url: string };
      video?: { url: string };
    };
    if (result.video?.url) return { state: 'done', url: result.video.url, contentType: 'video/mp4' };
    const imageUrl = result.images?.[0]?.url ?? result.image?.url;
    if (!imageUrl) return { state: 'failed', error: 'provider_blocked' };
    return { state: 'done', bytes: await fetchBytes(imageUrl), contentType: 'image/png' };
  },

  async cancel(providerRef: string): Promise<void> {
    const ref = JSON.parse(providerRef) as { statusUrl: string; responseUrl: string };
    if (!ref.responseUrl.startsWith(FAL_BASE)) return;
    const statusRes = await fetch(ref.statusUrl, { headers: await auth() });
    if (!statusRes.ok) return;
    const status = (await statusRes.json()) as { status: string };
    if (status.status !== 'IN_QUEUE') return;
    await fetch(`${ref.responseUrl}/cancel`, { method: 'PUT', headers: await auth() });
  },
```

Keep the existing image `contentType` detection if `check` already sniffed it — the only new lines are the `video?.url` early return, `queuePosition`, `phase`, and `cancel`.

- [ ] **Step 5: Run tests**

Run: `cd supabase/functions && deno test --allow-all _shared; cd ../..`
Expected: `ok | 36 passed` (32 + 4).

User commits.

---

### Task 9: Provider registry

**Files:**
- Modify: `supabase/functions/_shared/providers/index.ts`

**Interfaces:**
- Produces: `adapterFor('veo'|'omni'|'kling'|'runway'|'seedance')` resolves.

- [ ] **Step 1: Add imports and entries**

```ts
import { googleOmniAdapter } from './google-omni.ts';
import { googleVideoAdapter } from './google-video.ts';
import { runwayAdapter } from './runway.ts';
```

Add to `BY_FAMILY`:

```ts
  veo: googleVideoAdapter,
  omni: googleOmniAdapter,
  kling: falAdapter,
  runway: runwayAdapter,
  seedance: falAdapter,
```

Remove any existing `sora` entry if present.

- [ ] **Step 2: Type-check**

Run: `cd supabase/functions && deno check api/index.ts; cd ../..`
Expected: no errors. If `index.ts` complains that `finishJob`'s `result.bytes` no longer narrows (because `CheckResult` done now has two shapes), that is expected and fixed in Task 12 — temporarily guard with `if (!('bytes' in result)) return;` above the upload line so the check passes.

User commits.

---

### Task 10: Pure gateway rules for video

**Files:**
- Create: `supabase/functions/_shared/video-rules.ts`
- Test: `supabase/functions/_shared/video-rules_test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const MAX_PENDING_VIDEO_JOBS = 3;
  export interface ReferenceRule { min: number; max: number; needsParent: boolean }
  export function referenceRule(mode: VideoMode): ReferenceRule;
  export function videoJobCapReached(pendingCount: number): boolean;
  export function dailyCapState(spentUsd: number, oldestChargeAt: Date | null, now: Date): { blocked: boolean; resetsAt: string | null };
  export function expectedSecondsFor(family: ModelFamily, durationS: number | undefined): number;
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { assertEquals } from 'jsr:@std/assert';
import { familyById } from './model-families.ts';
import { dailyCapState, expectedSecondsFor, referenceRule, videoJobCapReached } from './video-rules.ts';

Deno.test('referenceRule per mode', () => {
  assertEquals(referenceRule('t2v'), { min: 0, max: 0, needsParent: false });
  assertEquals(referenceRule('i2v'), { min: 1, max: 1, needsParent: false });
  assertEquals(referenceRule('ref2v'), { min: 1, max: 3, needsParent: false });
  assertEquals(referenceRule('keyframes'), { min: 2, max: 2, needsParent: false });
  assertEquals(referenceRule('extend'), { min: 0, max: 0, needsParent: true });
  assertEquals(referenceRule('edit'), { min: 0, max: 0, needsParent: true });
});

Deno.test('videoJobCapReached at 3', () => {
  assertEquals(videoJobCapReached(2), false);
  assertEquals(videoJobCapReached(3), true);
});

Deno.test('dailyCapState blocks at $40 and reports reset 24 h after oldest charge', () => {
  const now = new Date('2026-09-06T12:00:00Z');
  const oldest = new Date('2026-09-05T15:30:00Z');
  assertEquals(dailyCapState(12.5, oldest, now), { blocked: false, resetsAt: null });
  assertEquals(dailyCapState(40, oldest, now), { blocked: true, resetsAt: '2026-09-06T15:30:00.000Z' });
  assertEquals(dailyCapState(41, null, now), { blocked: true, resetsAt: '2026-09-07T12:00:00.000Z' });
});

Deno.test('expectedSecondsFor = expectedSPerS × duration', () => {
  assertEquals(expectedSecondsFor(familyById('veo')!, 8), 96);
  assertEquals(expectedSecondsFor(familyById('kling')!, undefined), 100);
  assertEquals(expectedSecondsFor(familyById('flux')!, 5), 30);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd supabase/functions && deno test --allow-all _shared/video-rules_test.ts; cd ../..`
Expected: `Module not found "./video-rules.ts"`.

- [ ] **Step 3: Write `video-rules.ts`**

```ts
import { VIDEO_DAILY_CAP_USD, type ModelFamily, type VideoMode } from './model-families.ts';

export const MAX_PENDING_VIDEO_JOBS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const FALLBACK_EXPECTED_S = 30;

export interface ReferenceRule {
  min: number;
  max: number;
  needsParent: boolean;
}

const RULES: Record<VideoMode, ReferenceRule> = {
  t2v: { min: 0, max: 0, needsParent: false },
  i2v: { min: 1, max: 1, needsParent: false },
  ref2v: { min: 1, max: 3, needsParent: false },
  keyframes: { min: 2, max: 2, needsParent: false },
  extend: { min: 0, max: 0, needsParent: true },
  edit: { min: 0, max: 0, needsParent: true },
};

export function referenceRule(mode: VideoMode): ReferenceRule {
  return RULES[mode];
}

export function videoJobCapReached(pendingCount: number): boolean {
  return pendingCount >= MAX_PENDING_VIDEO_JOBS;
}

export function dailyCapState(
  spentUsd: number,
  oldestChargeAt: Date | null,
  now: Date,
): { blocked: boolean; resetsAt: string | null } {
  if (spentUsd < VIDEO_DAILY_CAP_USD) return { blocked: false, resetsAt: null };
  const anchor = oldestChargeAt ?? now;
  return { blocked: true, resetsAt: new Date(anchor.getTime() + DAY_MS).toISOString() };
}

export function expectedSecondsFor(family: ModelFamily, durationS: number | undefined): number {
  const perS = family.capabilities.expectedSPerS;
  const dur = durationS ?? family.capabilities.durations?.[0] ?? 5;
  if (!perS) return FALLBACK_EXPECTED_S;
  return perS * dur;
}
```

- [ ] **Step 4: Run tests**

Run: `cd supabase/functions && deno test --allow-all _shared; cd ../..`
Expected: `ok | 40 passed` (36 + 4).

User commits.

---

### Task 11: Gateway — `POST /generations` video branch

**Files:**
- Modify: `supabase/functions/api/index.ts` (imports L8–22, `sanitizeSettings` L118–131, `POST /generations` L700–915)

**Interfaces:**
- Consumes: Task 1 types, Task 5 `SubmitCtx`/`SubmitResult`, Task 4 `storageFor`, Task 10 rules.
- Produces: request body accepts `mode: VideoMode`, `referencePaths: string[]` (paths returned by `POST /uploads` as `uploadId`), `parentId`. Error codes: 400 `unsupported_mode`, 400 `bad_reference_count`, 400 `bad_parent`, 429 `too_many_jobs`, 429 `daily_cap` (+ `resetsAt`), 422 `content_policy`. Helper `signStored(backend, path, ttlS)` used by Tasks 12–13. `generations.settings.interactionId` persisted for Omni.

No Deno unit test covers `index.ts` (Hono app with live Supabase client). Verification = `deno check` + the Task 24 live smoke.

- [ ] **Step 1: Imports**

Extend the `./_shared/model-families.ts` import with `STUDIO_MARGIN, videoFamilySupports, type ModelFamily, type VideoMode`. Add:

```ts
import { storageFor, videoPath, thumbPath, type StorageBackend } from './_shared/storage/index.ts';
import { dailyCapState, expectedSecondsFor, referenceRule, videoJobCapReached } from './_shared/video-rules.ts';
import { isUrlResult, type SubmitResult } from './_shared/providers/types.ts';
```

(`videoPath`, `thumbPath`, `expectedSecondsFor`, `isUrlResult` are used in Tasks 12–13; importing now keeps one edit.)

- [ ] **Step 2: `sanitizeSettings` — accept audio / mode**

Add before `return clean;`:

```ts
  if (src.audio === 'off' || src.audio === 'on' || src.audio === 'voice') clean.audio = src.audio;
  if (typeof src.mode === 'string' && VIDEO_MODES.has(src.mode)) clean.mode = src.mode as VideoMode;
```

`interactionId` is NEVER accepted from the client (a spoofed id could chain onto another user's Omni conversation). It is derived server-side from the parent row in `prepareVideo` and persisted from `SubmitResult.interactionId`.

And above the function:

```ts
const VIDEO_MODES: ReadonlySet<string> = new Set(['t2v', 'i2v', 'ref2v', 'keyframes', 'extend', 'edit']);
const REF_SIGN_TTL_S = 3600;
const UPLOAD_PATH = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(png|jpg|jpeg|webp)$/i;
```

- [ ] **Step 3: Add `signStored` next to `signMedia` (~L290)**

```ts
const r2SignMemo = new Map<string, { url: string; exp: number }>();

async function signStored(backend: StorageBackend, path: string | null, ttlS = SIGN_TTL_S): Promise<string> {
  if (!path) return '';
  if (backend !== 'r2') return signMedia(path);
  const hit = r2SignMemo.get(path);
  if (hit && hit.exp > Date.now()) return hit.url;
  const url = await storageFor('r2').signedUrl(path, ttlS);
  r2SignMemo.set(path, { url, exp: Date.now() + (ttlS - 60) * 1000 });
  return url;
}
```

- [ ] **Step 4: Add the video preparation helper (above `app.post('/generations'…)`)**

```ts
interface VideoPrep {
  mode: VideoMode;
  referencePaths: string[];
  referenceUrls: string[];
  parentVideoUrl?: string;
  interactionId?: string;
}

/** Validates + prepares a video request. Returns a Response on rejection. */
async function prepareVideo(
  c: Context,
  userId: string,
  family: ModelFamily,
  settings: GenerationSettings,
  body: Record<string, unknown>,
  parentId: string | null,
): Promise<VideoPrep | Response> {
  const mode = settings.mode ?? 't2v';
  if (!videoFamilySupports(family, mode)) {
    return fail(c, 400, 'unsupported_mode', `${family.name} cannot do ${mode}.`);
  }
  const rule = referenceRule(mode);
  const rawRefs = Array.isArray(body.referencePaths) ? body.referencePaths : [];
  const referencePaths = rawRefs.filter((p): p is string => typeof p === 'string' && UPLOAD_PATH.test(p));
  if (referencePaths.length !== rawRefs.length || referencePaths.length < rule.min || referencePaths.length > rule.max) {
    return fail(c, 400, 'bad_reference_count', `${mode} needs ${rule.min}–${rule.max} reference image(s).`);
  }
  if (referencePaths.some((p) => !p.startsWith(`${userId}/`))) {
    return fail(c, 400, 'bad_reference_count', 'Reference does not belong to you.');
  }

  const prep: VideoPrep = { mode, referencePaths, referenceUrls: [] };

  if (rule.needsParent) {
    if (!parentId) return fail(c, 400, 'bad_parent', 'Pick a finished video to extend or edit.');
    const { data: parent } = await admin
      .from('generations')
      .select('id,kind,status,media_path,storage_backend,settings,family_id')
      .eq('id', parentId)
      .eq('user_id', userId)
      .maybeSingle();
    const usable = parent && parent.kind === MediaKind.Video && parent.status === 'done' && parent.media_path;
    if (!usable) return fail(c, 400, 'bad_parent', 'Pick a finished video to extend or edit.');
    prep.parentVideoUrl = await signStored(parent.storage_backend as StorageBackend, parent.media_path, REF_SIGN_TTL_S);
    const parentInteraction = (parent.settings as GenerationSettings | null)?.interactionId;
    if (family.id === 'omni' && parent.family_id === 'omni' && parentInteraction) prep.interactionId = parentInteraction;
  }

  const { count: pendingCount } = await admin
    .from('generations')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('kind', MediaKind.Video)
    .eq('status', 'pending');
  if (videoJobCapReached(pendingCount ?? 0)) {
    return fail(c, 429, 'too_many_jobs', '3 videos are still rendering — wait for one to finish.');
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: recent } = await admin
    .from('generations')
    .select('price_credits,created_at')
    .eq('user_id', userId)
    .eq('kind', MediaKind.Video)
    .neq('status', 'failed')
    .gte('created_at', since)
    .order('created_at', { ascending: true });
  const spentUsd = (recent ?? []).reduce((sum, r) => sum + Number(r.price_credits), 0) * (1 - STUDIO_MARGIN) / 100;
  const oldest = recent?.[0]?.created_at ? new Date(recent[0].created_at) : null;
  const cap = dailyCapState(spentUsd, oldest, new Date());
  if (cap.blocked) {
    return c.json({ error: 'daily_cap', message: 'Daily video limit reached.', resetsAt: cap.resetsAt }, 429);
  }

  for (const path of referencePaths) {
    const { data: signed, error } = await admin.storage.from('uploads').createSignedUrl(path, REF_SIGN_TTL_S);
    if (error || !signed) return fail(c, 400, 'bad_reference_count', 'Reference upload not found.');
    const mod = await moderate({ imageUrl: signed.signedUrl });
    if (mod.flagged) {
      await recordStrike(userId, 'upload', null, mod.categories, path);
      return fail(c, 422, 'content_policy', 'A reference image was blocked by moderation.');
    }
    prep.referenceUrls.push(signed.signedUrl);
  }
  return prep;
}
```

`Context` is Hono's — add `type Context` to the existing `jsr:@hono/hono` import.

- [ ] **Step 5: Wire into `POST /generations`**

Inside the `else` branch where `family` is resolved (after the existing `pro_required` check, before `unitCredits = creditCost(family, settings)`), and after `gate`/prompt moderation have run, insert the video prep. Concretely, immediately after the line `const mod = await moderate({ text: effectivePrompt }); … 422 content_policy` block:

```ts
    let video: VideoPrep | null = null;
    if (kind === MediaKind.Video) {
      const family = familyById(familyId)!;
      const prep = await prepareVideo(c, userId, family, settings, body as Record<string, unknown>, parentId);
      if (prep instanceof Response) return prep;
      video = prep;
      batch = 1;
    }
```

`batch` must be declared with `let` (it is currently `const batch = …` — change to `let`). Also relax the existing check `if (family.kind === MediaKind.Video && op !== Generate && op !== Variation)` — keep it; extend/edit still travel as `op: 'generate'` with `settings.mode`.

- [ ] **Step 6: Dispatch with video context**

In the dispatch loop, replace the `adapter.submit({...})` call with:

```ts
        const submitted: SubmitResult = await adapter.submit({
          familyId,
          op,
          prompt: effectivePrompt,
          settings: { ...settings },
          referenceUrl,
          maskPngBase64,
          loraUrl: persona?.lora_url,
          safetyId: sid,
          mode: video?.mode,
          referenceUrls: video?.referenceUrls,
          parentVideoUrl: video?.parentVideoUrl,
          interactionId: video?.interactionId,
        });
        await admin.from('jobs').update({ provider_ref: submitted.providerRef }).eq('id', jobRow!.id);
        if (submitted.interactionId) {
          await admin
            .from('generations')
            .update({ settings: { ...settings, interactionId: submitted.interactionId } })
            .eq('id', genId);
        }
```

In the `catch (e)` of that loop, map adapter `unsupported_mode` to `fn_fail_job(job, 'unsupported_mode')` (already refunds) — the existing generic path does this via `String(e).slice(0,500)`; keep it.

- [ ] **Step 7: Type-check**

Run: `cd supabase/functions && deno check api/index.ts; cd ../..`
Expected: no errors (the Task 9 temporary `'bytes' in result` guard in `finishJob` may still be present — Task 12 replaces it).

User commits.

---

### Task 12: Gateway — `GET /jobs` progress + `finishJob` streaming to R2

**Files:**
- Modify: `supabase/functions/api/index.ts` (`toGenerationDto` L301–316, `finishJob` L368–386, `GET /jobs` L660–698)

**Interfaces:**
- Consumes: `isUrlResult`, `storageFor`, `videoPath`, `signStored`, `expectedSecondsFor`.
- Produces `GenerationDto` (server side) with:
  ```ts
  thumbUrl?: string; storageBackend?: 'supabase'|'r2'; durationS?: number;
  job?: { progress?: number; phase?: 'queued'|'rendering'|'saving'; queuePosition?: number;
          cancellable: boolean; expectedS: number; startedAt: string };  // pending only
  ```
- `finishJob(job, result)` now accepts `job: { id; user_id; generation_id; attempts?: number }`.

- [ ] **Step 1: Extend `toGenerationDto`**

```ts
type JobRow = {
  id: string;
  generation_id: string;
  progress: number | null;
  phase: string | null;
  claimed_at: string | null;
  created_at: string;
};

const NOT_CANCELLABLE = new Set(['veo', 'omni']);

function jobDto(row: Record<string, unknown>, job: JobRow | undefined) {
  if (!job || row.status !== 'pending') return undefined;
  const family = familyById(String(row.family_id));
  const settings = (row.settings ?? {}) as GenerationSettings;
  return {
    progress: job.progress ?? undefined,
    phase: (job.claimed_at ? 'saving' : job.phase ?? 'queued') as 'queued' | 'rendering' | 'saving',
    cancellable: !NOT_CANCELLABLE.has(String(row.family_id)),
    expectedS: family ? expectedSecondsFor(family, settings.durationS) : 30,
    startedAt: job.created_at,
  };
}

async function toGenerationDto(row: Record<string, unknown>, job?: JobRow) {
  const backend = (row.storage_backend ?? 'supabase') as StorageBackend;
  return {
    id: row.id,
    kind: row.kind,
    familyId: row.family_id,
    familyName: row.family_name,
    op: row.op,
    prompt: row.prompt,
    settings: row.settings,
    priceCredits: Number(row.price_credits),
    status: row.status,
    mediaUrl: await signStored(backend, (row.media_path as string | null) ?? null),
    thumbUrl: row.thumb_path ? await signStored(backend, row.thumb_path as string) : undefined,
    storageBackend: row.kind === MediaKind.Video ? backend : undefined,
    durationS: row.duration_s == null ? undefined : Number(row.duration_s),
    parentId: row.parent_id,
    createdAt: row.created_at,
    job: jobDto(row, job),
  };
}

async function toGenerationDtos(rows: Record<string, unknown>[], jobs: Map<string, JobRow> = new Map()) {
  return Promise.all(rows.map((r) => toGenerationDto(r, jobs.get(String(r.id)))));
}
```

(Keep the parameter types you already have for `row` — the existing code types it as the generations row; only the added fields matter.)

- [ ] **Step 2: Replace `finishJob`**

```ts
const MAX_STORE_ATTEMPTS = 3;

async function finishJob(
  job: { id: string; user_id: string; generation_id: string; attempts?: number },
  result: CheckResult,
): Promise<void> {
  if (result.state === 'running') {
    await admin
      .from('jobs')
      .update({ progress: result.progress ?? null, phase: result.phase ?? null, updated_at: new Date().toISOString() })
      .eq('id', job.id);
    return;
  }
  if (result.state === 'failed') {
    await admin.rpc('fn_fail_job', { p_job: job.id, p_error: result.error });
    notifySettled(job.user_id, job.generation_id, 'generation_failed');
    return;
  }
  if (isUrlResult(result)) {
    await storeVideoResult(job, result);
    return;
  }
  const path = `${job.user_id}/${job.generation_id}.png`;
  await admin.storage.from('media').upload(path, result.bytes, { contentType: result.contentType, upsert: true });
  await admin.from('generations').update({ status: 'done', media_path: path }).eq('id', job.generation_id);
  await admin.from('jobs').update({ updated_at: new Date().toISOString() }).eq('id', job.id);
  notifySettled(job.user_id, job.generation_id, 'generation_done');
}

async function storeVideoResult(
  job: { id: string; user_id: string; generation_id: string; attempts?: number },
  result: Extract<CheckResult, { url: string }>,
): Promise<void> {
  // Claim: only one poller streams the file. No row back → someone else has it.
  const { data: claimed } = await admin
    .from('jobs')
    .update({ claimed_at: new Date().toISOString(), phase: 'saving' })
    .eq('id', job.id)
    .is('claimed_at', null)
    .select('id');
  if (!claimed || claimed.length === 0) return;

  const path = videoPath(job.user_id, job.generation_id);
  try {
    const res = await fetch(result.url, { headers: result.headers });
    if (!res.ok || !res.body) throw new Error(`video fetch ${res.status}`);
    await storageFor('r2').put(path, res.body, result.contentType || 'video/mp4');
  } catch (e) {
    const attempts = (job.attempts ?? 0) + 1;
    console.error('store_failed', job.id, attempts, e);
    if (attempts >= MAX_STORE_ATTEMPTS) {
      await admin.rpc('fn_fail_job', { p_job: job.id, p_error: 'store_failed' });
      notifySettled(job.user_id, job.generation_id, 'generation_failed');
      return;
    }
    await admin.from('jobs').update({ claimed_at: null, phase: 'rendering', attempts }).eq('id', job.id);
    return;
  }

  await admin
    .from('generations')
    .update({
      status: 'done',
      media_path: path,
      storage_backend: 'r2',
      duration_s: result.durationS ?? null,
      width: result.width ?? null,
      height: result.height ?? null,
    })
    .eq('id', job.generation_id);
  await admin.from('jobs').update({ progress: 1, updated_at: new Date().toISOString() }).eq('id', job.id);
  notifySettled(job.user_id, job.generation_id, 'generation_done');
}
```

Remove the temporary `'bytes' in result` guard from Task 9 if you added it.

- [ ] **Step 3: Update `GET /jobs`**

Change the jobs select to `id,user_id,generation_id,provider_ref,error,progress,phase,claimed_at,created_at,attempts`. In the loop, skip jobs with `claimed_at` set (another request is saving) in addition to the existing `error`/`provider_ref`/`inline` skips:

```ts
      if (job.error || !job.provider_ref || job.provider_ref === 'inline' || job.claimed_at) continue;
```

Pass `attempts` into `finishJob`:

```ts
        await finishJob({ id: job.id, user_id: job.user_id, generation_id: job.generation_id, attempts: job.attempts }, result);
```

After the loop, re-read jobs for the response so `progress/phase/claimed_at` reflect this tick, then build the map:

```ts
    const { data: freshJobs } = await admin
      .from('jobs')
      .select('id,generation_id,progress,phase,claimed_at,created_at')
      .eq('user_id', userId)
      .in('generation_id', ids);
    const jobsByGen = new Map<string, JobRow>((freshJobs ?? []).map((j) => [j.generation_id, j as JobRow]));
    const { data: gens } = await admin.from('generations').select('*').eq('user_id', userId).in('id', ids);
    return c.json({ items: await toGenerationDtos(gens ?? [], jobsByGen) });
```

- [ ] **Step 4: Type-check**

Run: `cd supabase/functions && deno check api/index.ts; cd ../..`
Expected: no errors.

User commits.

---

### Task 13: Gateway — cancel, thumbnail upload, storage cleanup on delete

**Files:**
- Modify: `supabase/functions/api/index.ts` (add two routes; extend `DELETE /generations/:id` L1670–1680)

**Interfaces:**
- Produces:
  - `POST /jobs/:generationId/cancel` → `200 { refundedCredits: number, credits: CreditsDto }`; 404 `not_found`; 409 `not_pending`; 409 `not_cancellable` (veo/omni).
  - `POST /generations/:id/thumb` multipart field `file` (JPEG ≤ 512 KB) → `200 { thumbUrl }`; 404; 409 `not_ready`; 413 `too_large`; 415 `bad_type`.
  - `DELETE /generations/:id` also deletes the stored media + thumb (best effort).

- [ ] **Step 1: Cancel route** (place next to `GET /jobs`)

```ts
app.post('/jobs/:id/cancel', async (c) => {
  const userId = c.get('userId') as string;
  const generationId = c.req.param('id');
  const { data: gen } = await admin
    .from('generations')
    .select('id,status,family_id,price_credits,kind')
    .eq('id', generationId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!gen) return fail(c, 404, 'not_found', 'Generation not found.');
  if (gen.status !== 'pending') return fail(c, 409, 'not_pending', 'Already finished.');
  if (NOT_CANCELLABLE.has(gen.family_id)) {
    return fail(c, 409, 'not_cancellable', "This model can't be cancelled once started.");
  }
  const { data: job } = await admin
    .from('jobs')
    .select('id,provider_ref,claimed_at')
    .eq('generation_id', generationId)
    .is('error', null)
    .maybeSingle();
  if (!job) return fail(c, 404, 'not_found', 'Job not found.');
  if (job.claimed_at) return fail(c, 409, 'not_pending', 'Already saving.');

  const adapter = adapterFor(gen.family_id);
  if (adapter.cancel && job.provider_ref && job.provider_ref !== 'inline') {
    try {
      await adapter.cancel(job.provider_ref);
    } catch (e) {
      logError(c, 'provider_cancel_failed', e);
    }
  }
  await admin.rpc('fn_fail_job', { p_job: job.id, p_error: 'cancelled' });
  return c.json({ refundedCredits: Number(gen.price_credits), credits: await creditsOf(userId) });
});
```

Look at how the user id is read in neighbouring routes (`c.get('userId')` vs a local helper) and match it.

- [ ] **Step 2: Thumbnail route** (place next to `POST /uploads`)

```ts
const THUMB_MAX_BYTES = 512 * 1024;

app.post('/generations/:id/thumb', async (c) => {
  const userId = c.get('userId') as string;
  const generationId = c.req.param('id');
  const { data: gen } = await admin
    .from('generations')
    .select('id,kind,status,storage_backend,thumb_path')
    .eq('id', generationId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!gen || gen.kind !== MediaKind.Video) return fail(c, 404, 'not_found', 'Video not found.');
  if (gen.status !== 'done') return fail(c, 409, 'not_ready', 'Video is not finished.');

  const form = await c.req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return fail(c, 400, 'invalid_file', 'Missing file.');
  if (file.size > THUMB_MAX_BYTES) return fail(c, 413, 'too_large', 'Thumbnail must be ≤ 512 KB.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if (!isJpeg) return fail(c, 415, 'bad_type', 'Thumbnail must be JPEG.');

  const backend = (gen.storage_backend ?? 'r2') as StorageBackend;
  const path = thumbPath(userId, generationId);
  await storageFor(backend).put(path, bytes, 'image/jpeg');
  await admin.from('generations').update({ thumb_path: path }).eq('id', generationId);
  return c.json({ thumbUrl: await signStored(backend, path) });
});
```

- [ ] **Step 3: Cleanup on delete**

Replace the body of `DELETE /generations/:id`:

```ts
app.delete('/generations/:id', async (c) => {
  const userId = c.get('userId') as string;
  const id = c.req.param('id');
  const { data: row } = await admin
    .from('generations')
    .delete()
    .eq('id', id)
    .eq('user_id', userId)
    .select('id,media_path,thumb_path,storage_backend')
    .maybeSingle();
  if (!row) return fail(c, 404, 'not_found', 'Generation not found.');
  const backend = (row.storage_backend ?? 'supabase') as StorageBackend;
  const paths = [row.media_path, row.thumb_path].filter((p): p is string => !!p);
  for (const p of paths) {
    try {
      await storageFor(backend).delete(p);
    } catch (e) {
      logError(c, 'storage_delete_failed', e);
    }
  }
  return c.json({ ok: true });
});
```

- [ ] **Step 4: Type-check + run all Deno tests**

Run: `cd supabase/functions && deno check api/index.ts && deno test --allow-all _shared; cd ../..`
Expected: check clean; `ok | 40 passed`.

User commits.

---

### Task 14: Client — DTOs, store actions, poller backoff

**Files:**
- Modify: `src/app/core/api/dtos.ts` (L71–83)
- Modify: `src/app/core/generations/generation-store.ts`
- Modify: `src/app/core/jobs/job-poller.ts`
- Test: `src/app/core/generations/generation-store.spec.ts`, `src/app/core/jobs/job-poller.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export type JobPhase = 'queued' | 'rendering' | 'saving';
  export interface JobProgressDto { progress?: number; phase?: JobPhase; queuePosition?: number; cancellable: boolean; expectedS: number; startedAt: string }
  GenerationDto += thumbUrl?: string; storageBackend?: 'supabase'|'r2'; durationS?: number; job?: JobProgressDto
  CreateGenerationRequest += mode?: VideoMode; referencePaths?: string[]
  export interface CancelJobResponse { refundedCredits: number; credits: CreditsDto }
  export interface ThumbResponse { thumbUrl: string }
  GenerationStore: cancel(id): Promise<number>; setThumb(id, url): void; pendingVideoCount: Signal<number>
  JobPoller: export function pollIntervalMs(elapsedMs: number, hasVideo: boolean): number
  ```

- [ ] **Step 1: DTOs**

In `dtos.ts`, import `VideoMode` from `'../catalog/model-families'` and change:

```ts
export type JobPhase = 'queued' | 'rendering' | 'saving';

export interface JobProgressDto {
  progress?: number;
  phase?: JobPhase;
  queuePosition?: number;
  cancellable: boolean;
  expectedS: number;
  startedAt: string;
}

export interface GenerationDto {
  id: string;
  kind: MediaKind;
  familyId: string;
  familyName: string;
  op: GenerationOp;
  prompt: string;
  settings: GenerationSettings;
  priceCredits: number;
  status: GenerationStatus;
  mediaUrl: string;
  thumbUrl?: string;
  storageBackend?: 'supabase' | 'r2';
  durationS?: number;
  job?: JobProgressDto;
  parentId: string | null;
  createdAt: string;
}

export interface CreateGenerationRequest {
  familyId?: string;
  op: GenerationOp;
  prompt: string;
  style?: string;
  settings: GenerationSettings;
  batch: number;
  parentId?: string;
  referenceUploadId?: string;
  referencePaths?: string[];
  maskPngBase64?: string;
  personaId?: string;
  trendId?: string;
}

export interface CancelJobResponse {
  refundedCredits: number;
  credits: CreditsDto;
}

export interface ThumbResponse {
  thumbUrl: string;
}
```

(`mode` travels inside `settings.mode`; no separate field.)

- [ ] **Step 2: Store tests**

Append to `generation-store.spec.ts` inside the main `describe`:

```ts
  it('cancel posts to /jobs/:id/cancel, marks the item failed and returns refunded credits', async () => {
    const store = await makeWith([gen('g1', 'pending', 40)]);
    apiMock.post.mockResolvedValue({ refundedCredits: 40, credits: { total: 100 } });
    const refunded = await store.cancel('g1');
    expect(apiMock.post).toHaveBeenCalledWith('/jobs/g1/cancel', {});
    expect(refunded).toBe(40);
    expect(store.byId('g1')?.status).toBe('failed');
    expect(ledgerMock.setCredits).toHaveBeenCalledWith({ total: 100 });
  });

  it('pendingVideoCount counts only pending videos', async () => {
    const store = await makeWith([
      { ...gen('v1', 'pending'), kind: 'video' as const },
      { ...gen('v2', 'done'), kind: 'video' as const },
      gen('i1', 'pending'),
    ]);
    expect(store.pendingVideoCount()).toBe(1);
  });

  it('setThumb patches thumbUrl', async () => {
    const store = await makeWith([{ ...gen('v1', 'done'), kind: 'video' as const }]);
    store.setThumb('v1', 'https://t/v1.jpg');
    expect(store.byId('v1')?.thumbUrl).toBe('https://t/v1.jpg');
  });

  it('applyJobUpdates carries job progress on still-pending items', async () => {
    const store = await makeWith([{ ...gen('v1', 'pending'), kind: 'video' as const }]);
    store.applyJobUpdates([
      { ...gen('v1', 'pending'), kind: 'video', job: { progress: 0.4, phase: 'rendering', cancellable: true, expectedS: 96, startedAt: 'x' } },
    ]);
    expect(store.byId('v1')?.job?.progress).toBe(0.4);
    expect(notifMock.addMany).not.toHaveBeenCalled();
  });
```

If `ledgerMock.setCredits` shape differs from `{ total }`, use the shape `CreditsDto` already has in that spec.

- [ ] **Step 3: Run to verify failure**

Run: `npm test -- --watch=false 2>&1 | grep -E "✗|×|FAIL|Tests" | head`
Expected: 4 failures (`cancel` / `pendingVideoCount` / `setThumb` not functions).

- [ ] **Step 4: Store implementation**

Add imports `CancelJobResponse` to the dtos import. Add after `pendingIds()`:

```ts
  readonly pendingVideoCount = computed(
    () => this.itemsSig().filter((i) => i.status === 'pending' && i.kind === 'video').length,
  );

  async cancel(id: string): Promise<number> {
    const res = await this.api.post<CancelJobResponse>(`/jobs/${id}/cancel`, {});
    this.itemsSig.update((list) =>
      list.map((i) => (i.id === id ? { ...i, status: 'failed' as const, job: undefined } : i)),
    );
    this.ledger.setCredits(res.credits);
    void this.persist();
    return res.refundedCredits;
  }

  setThumb(id: string, thumbUrl: string): void {
    this.itemsSig.update((list) => list.map((i) => (i.id === id ? { ...i, thumbUrl } : i)));
    void this.persist();
  }
```

(`computed` from `@angular/core` — add to the import if missing. `this.ledger.setCredits` is what `create()` already calls after a charge; reuse the same call.) `applyJobUpdates` needs no change — it already replaces whole items, so `job` rides along.

- [ ] **Step 5: Poller test**

Append to `job-poller.spec.ts` (import `pollIntervalMs` from `'./job-poller'`):

```ts
  it('backs off slower for video than image', () => {
    expect(pollIntervalMs(0, false)).toBe(2000);
    expect(pollIntervalMs(60_000, false)).toBe(5000);
    expect(pollIntervalMs(0, true)).toBe(3000);
    expect(pollIntervalMs(31_000, true)).toBe(5000);
    expect(pollIntervalMs(121_000, true)).toBe(10_000);
  });
```

Also add `pendingVideoCount: () => 0` to the `store` mock object in that spec.

- [ ] **Step 6: Poller implementation**

Replace the constants and `schedule()`:

```ts
const FAST_MS = 2000;
const SLOW_MS = 5000;
const SLOW_AFTER_MS = 30_000;
const VIDEO_FAST_MS = 3000;
const VIDEO_SLOWEST_MS = 10_000;
const VIDEO_SLOWEST_AFTER_MS = 120_000;

export function pollIntervalMs(elapsedMs: number, hasVideo: boolean): number {
  if (!hasVideo) return elapsedMs > SLOW_AFTER_MS ? SLOW_MS : FAST_MS;
  if (elapsedMs > VIDEO_SLOWEST_AFTER_MS) return VIDEO_SLOWEST_MS;
  if (elapsedMs > SLOW_AFTER_MS) return SLOW_MS;
  return VIDEO_FAST_MS;
}
```

```ts
  private schedule(): void {
    const elapsed = Date.now() - this.startedAt;
    const delay = pollIntervalMs(elapsed, this.store.pendingVideoCount() > 0);
    this.timer = setTimeout(async () => {
      await this.tick();
      if (this.store.pendingIds().length > 0) this.schedule();
    }, delay);
  }
```

- [ ] **Step 7: Run tests + build**

Run: `npm test -- --watch=false 2>&1 | tail -4`
Expected: `Tests  208 passed` (203 + 5).

Run: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npx ng build 2>&1 | tail -3`
Expected: success.

User commits.

---

### Task 15: `mode-picker` component

**Files:**
- Create: `src/app/features/workspace/left-panel/mode-picker/mode-picker.ts`
- Create: `src/app/features/workspace/left-panel/mode-picker/mode-picker.html`
- Create: `src/app/features/workspace/left-panel/mode-picker/mode-picker.css`
- Test: `src/app/features/workspace/left-panel/mode-picker/mode-picker.spec.ts`

**Interfaces:**
- Produces: `<app-mode-picker [family] [selected] (changed)>` — `family: ModelFamily` (required), `selected: VideoMode` (required), `changed: VideoMode`. Renders one chip per mode in `MODE_LABELS` order; chips the family lacks are hidden (not disabled). Exported `MODE_LABELS: Record<VideoMode, string>`.

- [ ] **Step 1: Spec**

```ts
import { TestBed } from '@angular/core/testing';
import { familyById } from '../../../../core/catalog/model-families';
import { ModePicker } from './mode-picker';

describe('ModePicker', () => {
  function make(familyId: string, selected = 't2v') {
    const fixture = TestBed.createComponent(ModePicker);
    fixture.componentRef.setInput('family', familyById(familyId)!);
    fixture.componentRef.setInput('selected', selected);
    fixture.detectChanges();
    return fixture;
  }

  it('renders only the modes the family supports, in canonical order', () => {
    const fixture = make('runway');
    const labels = Array.from(fixture.nativeElement.querySelectorAll('button.mode-chip')).map((b) =>
      (b as HTMLElement).textContent!.trim(),
    );
    expect(labels).toEqual(['Text → Video', 'Image → Video']);
  });

  it('marks the selected chip and emits on click', () => {
    const fixture = make('omni', 'i2v');
    const emitted: string[] = [];
    fixture.componentInstance.changed.subscribe((m) => emitted.push(m));
    const chips = fixture.nativeElement.querySelectorAll('button.mode-chip') as NodeListOf<HTMLButtonElement>;
    expect(chips[1].classList.contains('mode-chip-on')).toBe(true);
    chips[5].click();
    expect(emitted).toEqual(['edit']);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- --watch=false 2>&1 | grep -E "mode-picker|Tests"`
Expected: cannot resolve `./mode-picker`.

- [ ] **Step 3: `mode-picker.ts`**

```ts
import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { ModelFamily, VideoMode } from '../../../../core/catalog/model-families';
import { Hint } from '../../../../shared/hint/hint';

export const MODE_LABELS: Record<VideoMode, string> = {
  t2v: 'Text → Video',
  i2v: 'Image → Video',
  ref2v: 'References → Video',
  keyframes: 'First + Last frame',
  extend: 'Extend',
  edit: 'Edit',
};

export const MODE_HINTS: Record<VideoMode, string> = {
  t2v: 'Describe the clip. No images needed.',
  i2v: 'One image becomes the opening frame.',
  ref2v: 'Up to 3 images guide characters, objects or style.',
  keyframes: 'Two images: where the clip starts and where it ends.',
  extend: 'Continue a finished video from your library.',
  edit: 'Change a finished video by describing the edit.',
};

const ORDER: VideoMode[] = ['t2v', 'i2v', 'ref2v', 'keyframes', 'extend', 'edit'];

@Component({
  selector: 'app-mode-picker',
  imports: [Hint],
  templateUrl: './mode-picker.html',
  styleUrl: './mode-picker.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ModePicker {
  readonly family = input.required<ModelFamily>();
  readonly selected = input.required<VideoMode>();
  readonly changed = output<VideoMode>();

  readonly labels = MODE_LABELS;
  readonly hints = MODE_HINTS;
  readonly modes = computed(() => {
    const supported = new Set(this.family().capabilities.modes ?? []);
    return ORDER.filter((m) => supported.has(m));
  });

  pick(mode: VideoMode): void {
    if (mode === this.selected()) return;
    this.changed.emit(mode);
  }
}
```

Check the actual path of the existing `app-hint` component (`grep -rl "selector: 'app-hint'" src/app`) and fix the import path if it is not `shared/hint/hint`.

- [ ] **Step 4: `mode-picker.html`**

```html
<div class="og">
  <div class="og-head">
    <span class="og-label">Mode</span>
  </div>
  <div class="mode-chips">
    @for (m of modes(); track m) {
      <app-hint [text]="hints[m]">
        <button
          type="button"
          class="mode-chip"
          [class.mode-chip-on]="m === selected()"
          (click)="pick(m)"
        >
          {{ labels[m] }}
        </button>
      </app-hint>
    }
  </div>
</div>
```

Match `.og` / `.og-head` / `.og-label` class names to what `option-group.html` uses so the section reads like its neighbours (`sed -n '1,30p' src/app/features/workspace/option-group/option-group.html`).

- [ ] **Step 5: `mode-picker.css`**

```css
.mode-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.mode-chip {
  padding: 5px 10px;
  border: 1px solid var(--border);
  border-radius: calc(var(--radius) - 2px);
  background: var(--card);
  color: var(--muted-foreground);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  transition: border-color 120ms, color 120ms, background 120ms;
}

.mode-chip:hover {
  color: var(--foreground);
  border-color: var(--foreground);
}

.mode-chip-on {
  background: var(--foreground);
  color: var(--background);
  border-color: var(--foreground);
}
```

- [ ] **Step 6: Run tests**

Run: `npm test -- --watch=false 2>&1 | tail -4`
Expected: `Tests  210 passed` (208 + 2).

User commits.

---

### Task 16: `reference-drop` component (1–3 images, keyframe slots)

**Files:**
- Create: `src/app/features/workspace/left-panel/reference-drop/reference-drop.ts`
- Create: `src/app/features/workspace/left-panel/reference-drop/reference-drop.html`
- Create: `src/app/features/workspace/left-panel/reference-drop/reference-drop.css`
- Test: `src/app/features/workspace/left-panel/reference-drop/reference-drop.spec.ts`

**Interfaces:**
- Produces: `<app-reference-drop [mode] [slots] (slotsChanged) (pickFromLibrary)>`.
  ```ts
  export interface RefSlot { path: string; url: string }          // path = uploadId from POST /uploads
  mode: VideoMode (required); slots: RefSlot[] (required); max computed from referenceRule
  slotsChanged: RefSlot[]; pickFromLibrary: number (slot index)
  ```
  Uploads go through `ApiService.postForm<UploadResponse>('/uploads', form)`; `UploadResponse.uploadId` is the path. Error text shown under the drop zone. Slot labels: keyframes → `First frame` / `Last frame`; ref2v → `Reference 1..3`; i2v → `Image`.

- [ ] **Step 1: Spec**

```ts
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { ApiService } from '../../../../core/api/api-service';
import { ReferenceDrop } from './reference-drop';

describe('ReferenceDrop', () => {
  const api = { postForm: vi.fn() };

  function make(mode: string, slots: { path: string; url: string }[] = []) {
    TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: api }] });
    const fixture = TestBed.createComponent(ReferenceDrop);
    fixture.componentRef.setInput('mode', mode);
    fixture.componentRef.setInput('slots', slots);
    fixture.detectChanges();
    return fixture;
  }

  it('shows two labelled slots for keyframes', () => {
    const fixture = make('keyframes');
    const labels = Array.from(fixture.nativeElement.querySelectorAll('.ref-slot-label')).map((e) =>
      (e as HTMLElement).textContent!.trim(),
    );
    expect(labels).toEqual(['First frame', 'Last frame']);
  });

  it('shows filled slots plus one empty slot up to the max for ref2v', () => {
    const fixture = make('ref2v', [{ path: 'u/a.png', url: 'blob:a' }]);
    expect(fixture.nativeElement.querySelectorAll('.ref-slot').length).toBe(2);
    expect(fixture.nativeElement.querySelectorAll('.ref-slot-filled').length).toBe(1);
  });

  it('uploads a dropped file and emits the new slot list', async () => {
    api.postForm.mockResolvedValue({ uploadId: 'u/x.png', url: 'https://s/x.png' });
    const fixture = make('i2v');
    const emitted: unknown[] = [];
    fixture.componentInstance.slotsChanged.subscribe((s) => emitted.push(s));
    await fixture.componentInstance.addFile(0, new File([new Uint8Array([1, 2])], 'x.png', { type: 'image/png' }));
    expect(api.postForm).toHaveBeenCalledWith('/uploads', expect.any(FormData));
    expect(emitted[0]).toEqual([{ path: 'u/x.png', url: 'https://s/x.png' }]);
  });

  it('surfaces moderation errors', async () => {
    api.postForm.mockRejectedValue({ error: 'content_policy', message: 'Image blocked.' });
    const fixture = make('i2v');
    await fixture.componentInstance.addFile(0, new File([new Uint8Array([1])], 'x.png', { type: 'image/png' }));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.ref-error').textContent).toContain('Image blocked.');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- --watch=false 2>&1 | grep -E "reference-drop|Tests"`
Expected: cannot resolve `./reference-drop`.

- [ ] **Step 3: `reference-drop.ts`**

```ts
import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideImagePlus, lucideLibrary, lucideX } from '@ng-icons/lucide';
import { ApiService } from '../../../../core/api/api-service';
import type { UploadResponse } from '../../../../core/api/dtos';
import type { VideoMode } from '../../../../core/catalog/model-families';

export interface RefSlot {
  path: string;
  url: string;
}

const MAX_BY_MODE: Partial<Record<VideoMode, number>> = { i2v: 1, ref2v: 3, keyframes: 2 };
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function slotLabel(mode: VideoMode, index: number): string {
  if (mode === 'keyframes') return index === 0 ? 'First frame' : 'Last frame';
  if (mode === 'ref2v') return `Reference ${index + 1}`;
  return 'Image';
}

@Component({
  selector: 'app-reference-drop',
  imports: [NgIcon],
  providers: [provideIcons({ lucideImagePlus, lucideLibrary, lucideX })],
  templateUrl: './reference-drop.html',
  styleUrl: './reference-drop.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReferenceDrop {
  private readonly api = inject(ApiService);

  readonly mode = input.required<VideoMode>();
  readonly slots = input.required<RefSlot[]>();
  readonly slotsChanged = output<RefSlot[]>();
  readonly pickFromLibrary = output<number>();

  readonly error = signal('');
  readonly uploadingIndex = signal<number | null>(null);

  readonly max = computed(() => MAX_BY_MODE[this.mode()] ?? 0);

  /** Filled slots + one empty (until max). Keyframes always show both. */
  readonly visible = computed(() => {
    const filled = this.slots();
    const shown = this.mode() === 'keyframes' ? this.max() : Math.min(filled.length + 1, this.max());
    return Array.from({ length: shown }, (_, i) => ({
      index: i,
      label: slotLabel(this.mode(), i),
      slot: filled[i] as RefSlot | undefined,
    }));
  });

  onFileInput(index: number, event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    (event.target as HTMLInputElement).value = '';
    if (!file) return;
    void this.addFile(index, file);
  }

  onDrop(index: number, event: DragEvent): void {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    void this.addFile(index, file);
  }

  allowDrop(event: DragEvent): void {
    event.preventDefault();
  }

  async addFile(index: number, file: File): Promise<void> {
    this.error.set('');
    if (!file.type.startsWith('image/')) {
      this.error.set('Only images can be used as references.');
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      this.error.set('Image must be under 10 MB.');
      return;
    }
    const form = new FormData();
    form.append('file', file);
    this.uploadingIndex.set(index);
    try {
      const res = await this.api.postForm<UploadResponse>('/uploads', form);
      this.place(index, { path: res.uploadId, url: res.url });
    } catch (e) {
      this.error.set(messageOf(e));
    } finally {
      this.uploadingIndex.set(null);
    }
  }

  place(index: number, slot: RefSlot): void {
    const next = [...this.slots()];
    next[index] = slot;
    this.slotsChanged.emit(next.filter((s): s is RefSlot => !!s));
  }

  clear(index: number): void {
    const next = this.slots().filter((_, i) => i !== index);
    this.slotsChanged.emit(next);
  }
}

function messageOf(e: unknown): string {
  const err = e as { message?: string; error?: string } | null;
  if (err?.message) return err.message;
  return 'Upload failed. Try another image.';
}
```

Note for keyframes: `clear(0)` shifts the last frame into slot 0. Acceptable — the labels update and the user re-adds. If `place` on index 1 with an empty slot 0 is needed, the filter compacts it to index 0; the keyframes label then reads "First frame" for that image. Keep it simple: keyframes UI shows both slots; both must be filled before Generate is enabled (Task 18 checks `slots.length === rule.min`).

- [ ] **Step 4: `reference-drop.html`**

```html
<div class="ref-slots">
  @for (v of visible(); track v.index) {
    <div class="ref-slot" [class.ref-slot-filled]="!!v.slot">
      <span class="ref-slot-label">{{ v.label }}</span>
      @if (v.slot; as slot) {
        <div class="ref-preview">
          <img [src]="slot.url" alt="" />
          <button type="button" class="ref-clear" (click)="clear(v.index)" aria-label="Remove reference">
            <ng-icon name="lucideX" size="12" />
          </button>
        </div>
      } @else {
        <label class="ref-drop" (dragover)="allowDrop($event)" (drop)="onDrop(v.index, $event)">
          @if (uploadingIndex() === v.index) {
            <span class="spinner"></span>
          } @else {
            <ng-icon name="lucideImagePlus" size="16" />
            <span>Drop or click</span>
          }
          <input type="file" accept="image/*" class="ref-file-input" (change)="onFileInput(v.index, $event)" />
        </label>
        <button type="button" class="ref-library" (click)="pickFromLibrary.emit(v.index)">
          <ng-icon name="lucideLibrary" size="12" />
          From library
        </button>
      }
    </div>
  }
</div>
@if (error()) {
  <p class="ref-error">{{ error() }}</p>
}
```

- [ ] **Step 5: `reference-drop.css`**

Reuse the class names `left-panel.css` already styles for `.ref-preview`, `.ref-clear`, `.ref-drop`, `.ref-file-input`, `.ref-error` — copy those rules verbatim from `left-panel.css` into this file (component styles are scoped), then add:

```css
.ref-slots {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ref-slot {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ref-slot-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted-foreground);
}

.ref-library {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: calc(var(--radius) - 2px);
  background: transparent;
  color: var(--muted-foreground);
  font-size: 12px;
  cursor: pointer;
}

.ref-library:hover {
  color: var(--foreground);
}
```

- [ ] **Step 6: Run tests**

Run: `npm test -- --watch=false 2>&1 | tail -4`
Expected: `Tests  214 passed` (210 + 4).

User commits.

---

### Task 17: `video-picker-dialog` (pick a finished video for Extend / Edit)

**Files:**
- Create: `src/app/features/workspace/video-picker-dialog/video-picker-dialog.ts`
- Create: `src/app/features/workspace/video-picker-dialog/video-picker-dialog.html`
- Create: `src/app/features/workspace/video-picker-dialog/video-picker-dialog.css`
- Test: `src/app/features/workspace/video-picker-dialog/video-picker-dialog.spec.ts`

**Interfaces:**
- Produces: `<app-video-picker-dialog [items] [familyId] (picked) (closed)>` — `items: GenerationItem[]` (required), `familyId: string` (required, the family that will extend/edit; only finished videos from any family are shown, but Omni `edit` requires the parent to be Omni — enforce with `[familyId]`), `picked: GenerationItem`, `closed: void`. Hand-rolled modal: `.backdrop` click → closed, `Escape` → closed.

- [ ] **Step 1: Spec**

```ts
import { TestBed } from '@angular/core/testing';
import type { GenerationItem } from '../../../core/generations/generation-store';
import { VideoPickerDialog } from './video-picker-dialog';

function item(id: string, status: string, kind: string, familyId = 'veo'): GenerationItem {
  return {
    id, status, kind, familyId, familyName: familyId, op: 'generate', prompt: `p-${id}`, settings: { aspectRatio: '16:9' },
    priceCredits: 1, mediaUrl: `https://m/${id}.mp4`, thumbUrl: `https://m/${id}.jpg`, parentId: null, createdAt: '2026-09-06T00:00:00Z',
  } as GenerationItem;
}

describe('VideoPickerDialog', () => {
  function make(items: GenerationItem[], familyId = 'veo') {
    const fixture = TestBed.createComponent(VideoPickerDialog);
    fixture.componentRef.setInput('items', items);
    fixture.componentRef.setInput('familyId', familyId);
    fixture.detectChanges();
    return fixture;
  }

  it('lists only finished videos', () => {
    const fixture = make([item('a', 'done', 'video'), item('b', 'pending', 'video'), item('c', 'done', 'image')]);
    expect(fixture.nativeElement.querySelectorAll('.pick-tile').length).toBe(1);
  });

  it('omni edit only offers omni videos', () => {
    const fixture = make([item('a', 'done', 'video', 'veo'), item('b', 'done', 'video', 'omni')], 'omni');
    expect(fixture.nativeElement.querySelectorAll('.pick-tile').length).toBe(1);
  });

  it('emits picked and closed', () => {
    const fixture = make([item('a', 'done', 'video')]);
    const picked: string[] = [];
    let closed = 0;
    fixture.componentInstance.picked.subscribe((i) => picked.push(i.id));
    fixture.componentInstance.closed.subscribe(() => closed++);
    (fixture.nativeElement.querySelector('.pick-tile') as HTMLButtonElement).click();
    (fixture.nativeElement.querySelector('.backdrop') as HTMLElement).click();
    expect(picked).toEqual(['a']);
    expect(closed).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- --watch=false 2>&1 | grep -E "video-picker|Tests"`
Expected: cannot resolve `./video-picker-dialog`.

- [ ] **Step 3: `video-picker-dialog.ts`**

```ts
import { ChangeDetectionStrategy, Component, computed, HostListener, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucidePlay, lucideX } from '@ng-icons/lucide';
import type { GenerationItem } from '../../../core/generations/generation-store';

@Component({
  selector: 'app-video-picker-dialog',
  imports: [NgIcon],
  providers: [provideIcons({ lucidePlay, lucideX })],
  templateUrl: './video-picker-dialog.html',
  styleUrl: './video-picker-dialog.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VideoPickerDialog {
  readonly items = input.required<GenerationItem[]>();
  readonly familyId = input.required<string>();
  readonly picked = output<GenerationItem>();
  readonly closed = output<void>();

  readonly candidates = computed(() => {
    const omniOnly = this.familyId() === 'omni';
    return this.items().filter((i) => {
      if (i.kind !== 'video' || i.status !== 'done') return false;
      if (omniOnly && i.familyId !== 'omni') return false;
      return true;
    });
  });

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.closed.emit();
  }

  onBackdrop(event: MouseEvent): void {
    if (event.target !== event.currentTarget) return;
    this.closed.emit();
  }
}
```

- [ ] **Step 4: `video-picker-dialog.html`**

```html
<div class="backdrop" (click)="onBackdrop($event)">
  <div class="panel" role="dialog" aria-label="Pick a video">
    <div class="panel-head">
      <h2>Pick a video</h2>
      <button type="button" class="close-btn" (click)="closed.emit()" aria-label="Close">
        <ng-icon name="lucideX" size="16" />
      </button>
    </div>
    @if (candidates().length === 0) {
      <p class="muted">No finished videos yet. Generate one first.</p>
    } @else {
      <div class="pick-grid">
        @for (v of candidates(); track v.id) {
          <button type="button" class="pick-tile" (click)="picked.emit(v)">
            @if (v.thumbUrl) {
              <img [src]="v.thumbUrl" alt="" />
            } @else {
              <span class="pick-dark"><ng-icon name="lucidePlay" size="20" /></span>
            }
            <span class="pick-caption">{{ v.familyName }} · {{ v.durationS ?? v.settings.durationS }}s</span>
          </button>
        }
      </div>
    }
  </div>
</div>
```

- [ ] **Step 5: `video-picker-dialog.css`**

Copy `.backdrop`, `.panel`, `.close-btn` rules from `detail-overlay.css` (same modal look), then:

```css
.panel {
  max-width: 720px;
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}

.panel-head h2 {
  font-size: 15px;
  font-weight: 600;
}

.pick-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 10px;
}

.pick-tile {
  position: relative;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: calc(var(--radius) - 2px);
  background: #111;
  padding: 0;
  cursor: pointer;
}

.pick-tile:hover {
  border-color: var(--foreground);
}

.pick-tile img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.pick-dark {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  color: #ddd;
}

.pick-caption {
  position: absolute;
  left: 6px;
  bottom: 6px;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgb(0 0 0 / 0.6);
  color: #fff;
  font-size: 11px;
}
```

- [ ] **Step 6: Run tests**

Run: `npm test -- --watch=false 2>&1 | tail -4`
Expected: `Tests  217 passed` (214 + 3).

User commits.

---

### Task 18: Left panel — unlock video, mode picker, references, audio, no batch

**Files:**
- Modify: `src/app/features/workspace/left-panel/left-panel.ts` (`videoLocked` L~120, `resolutionOptions` L188–205, `GenerateRequest`, new fields)
- Modify: `src/app/features/workspace/left-panel/left-panel.html`
- Modify: `src/app/features/workspace/left-panel/left-panel.css` (small)
- Modify: `src/app/features/workspace/workspace-page.ts` (`onGenerate` L308) + `workspace-page.html` (rail bindings, picker dialog)
- Test: `src/app/features/workspace/left-panel/left-panel.spec.ts`

**Interfaces:**
- Consumes: `ModePicker` (Task 15), `ReferenceDrop`/`RefSlot` (Task 16), `VideoPickerDialog` (Task 17), `videoFamilySupports`, `referenceRule` (client copy below), `ProfileStore.proActive`.
- Produces: `GenerateRequest` gains `referencePaths?: string[]`, `videoParentId?: string` (`settings.mode` already inside `settings`). New outputs `upgradeRequested: void`, `pickVideoRequested: void`. New public method `setVideoParent(item: GenerationItem | null)`. `videoLocked` becomes `computed(() => !this.profileStore.proActive())`.

- [ ] **Step 1: Client copy of the reference rule**

Add to `src/app/core/catalog/model-families.ts` (bottom, exported so it syncs to Deno too — Task 10's Deno `referenceRule` can then import from `./model-families.ts` instead; leave Task 10's version in place, they are identical):

```ts
export interface ReferenceRule {
  min: number;
  max: number;
  needsParent: boolean;
}

const REFERENCE_RULES: Record<VideoMode, ReferenceRule> = {
  t2v: { min: 0, max: 0, needsParent: false },
  i2v: { min: 1, max: 1, needsParent: false },
  ref2v: { min: 1, max: 3, needsParent: false },
  keyframes: { min: 2, max: 2, needsParent: false },
  extend: { min: 0, max: 0, needsParent: true },
  edit: { min: 0, max: 0, needsParent: true },
};

export function referenceRule(mode: VideoMode): ReferenceRule {
  return REFERENCE_RULES[mode];
}
```

Then `npm run sync-shared` and in `supabase/functions/_shared/video-rules.ts` delete its own `ReferenceRule`/`RULES`/`referenceRule` and re-export: `export { referenceRule, type ReferenceRule } from './model-families.ts';`. Deno tests still pass (`cd supabase/functions && deno test --allow-all _shared; cd ../..` → `ok | 40 passed`).

- [ ] **Step 2: Spec updates**

In `left-panel.spec.ts` change the `ProfileStore` mock to `{ isOwner: signal(true), proActive: signal(true) }`. Add tests:

```ts
  it('unlocks video for Pro and shows the mode picker', () => {
    const { fixture, component } = makeComponent();
    component.setMode('video');
    fixture.detectChanges();
    expect(component.videoLocked()).toBe(false);
    expect(fixture.nativeElement.querySelector('app-mode-picker')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.batch-group')).toBeNull();
  });

  it('hides batch and audio for included-audio families, shows audio chips for kling', () => {
    const { fixture, component } = makeComponent();
    component.setMode('video');
    component.setFamily('kling');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.audio-group')).not.toBeNull();
    component.setFamily('veo');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.audio-group')).toBeNull();
    expect(fixture.nativeElement.querySelector('.audio-note')).not.toBeNull();
  });

  it('blocks Generate until references satisfy the mode', () => {
    const { fixture, component } = makeComponent();
    component.setMode('video');
    component.setFamily('veo');
    component.prompt.set('a fox');
    component.setVideoMode('keyframes');
    fixture.detectChanges();
    expect(component.canGenerate()).toBe(false);
    component.refSlots.set([{ path: 'u/a.png', url: 'a' }, { path: 'u/b.png', url: 'b' }]);
    expect(component.canGenerate()).toBe(true);
  });

  it('emits referencePaths and videoParentId on generate', () => {
    const { fixture, component } = makeComponent();
    const reqs: unknown[] = [];
    component.generateRequested.subscribe((r) => reqs.push(r));
    component.setMode('video');
    component.setFamily('omni');
    component.prompt.set('make it rain');
    component.setVideoMode('edit');
    component.setVideoParent({ id: 'v9' } as never);
    fixture.detectChanges();
    component.generate();
    expect(reqs[0]).toMatchObject({ videoParentId: 'v9', referencePaths: [] });
    expect((reqs[0] as { settings: { mode: string } }).settings.mode).toBe('edit');
  });
```

If `makeComponent()` returns only the component, adapt (`fixture = TestBed.createComponent(LeftPanel)`); `setFamily` is the existing family-change method — check its name (`grep -n "familyId.set" src/app/features/workspace/left-panel/left-panel.ts`) and use that.

- [ ] **Step 3: Run to verify failure**

Run: `npm test -- --watch=false 2>&1 | grep -E "left-panel|Tests"`
Expected: 4 failures (`videoLocked` not callable, `setVideoMode` missing…).

- [ ] **Step 4: `left-panel.ts` changes**

Imports: `ModePicker`, `ReferenceDrop`, `type RefSlot`, `referenceRule`, `type VideoMode`, `videoFamilySupports`, `type GenerationItem`. Add `ModePicker, ReferenceDrop` to the component `imports`.

Replace `readonly videoLocked = true;` with:

```ts
  readonly videoLocked = computed(() => !this.profileStore.proActive());
  readonly upgradeRequested = output<void>();
  readonly pickVideoRequested = output<void>();

  readonly refSlots = signal<RefSlot[]>([]);
  readonly videoParent = signal<GenerationItem | null>(null);

  readonly videoMode = computed<VideoMode>(() => this.settings().mode ?? 't2v');
  readonly refRule = computed(() => referenceRule(this.videoMode()));
  readonly showReferences = computed(() => this.mode() === 'video' && this.refRule().max > 0);
  readonly showVideoParent = computed(() => this.mode() === 'video' && this.refRule().needsParent);
  readonly audioSelectable = computed(() => this.family().capabilities.audio === 'selectable');
  readonly audioIncluded = computed(() => this.family().capabilities.audio === 'included');
  readonly hideAspect = computed(() => this.mode() === 'video' && this.videoMode() !== 't2v');

  readonly audioOptions: FamilyOption[] = [
    { value: 'off', label: 'Off', tooltip: 'Silent clip. Cheapest.' },
    { value: 'on', label: 'Sound', tooltip: 'Ambient sound and music.' },
    { value: 'voice', label: 'Voice', tooltip: 'Sound plus spoken dialogue.' },
  ];

  readonly videoInputsReady = computed(() => {
    if (this.mode() !== 'video') return true;
    const rule = this.refRule();
    if (rule.needsParent) return this.videoParent() !== null;
    const n = this.refSlots().length;
    return n >= rule.min && n <= rule.max;
  });

  setVideoMode(mode: VideoMode): void {
    if (!videoFamilySupports(this.family(), mode)) return;
    this.settings.update((s) => ({ ...s, mode }));
    this.refSlots.set([]);
    this.videoParent.set(null);
  }

  setAudio(value: string): void {
    if (value !== 'off' && value !== 'on' && value !== 'voice') return;
    this.settings.update((s) => ({ ...s, audio: value }));
  }

  setVideoParent(item: GenerationItem | null): void {
    this.videoParent.set(item);
  }

  onVideoModeToggle(): void {
    if (this.videoLocked()) {
      this.upgradeRequested.emit();
      return;
    }
    this.setMode('video');
  }
```

Update `canGenerate` to also require `this.videoInputsReady()`. In `clampSettings()` (L354) add, after the existing clamps:

```ts
    if (f.kind === 'video' && !videoFamilySupports(f, s.mode ?? 't2v')) next.mode = 't2v';
    if (f.capabilities.audio !== 'selectable') delete next.audio;
    if (f.capabilities.audio === 'selectable' && !next.audio) next.audio = 'off';
    if (f.kind !== 'video') { delete next.mode; }
```

(`next` = the settings object being clamped; match the local name used there.) Also: `batch` for video must be 1 — in `priceCredits`, `const n = this.mode() === 'video' ? 1 : this.batch();`.

Extend `GenerateRequest`:

```ts
export interface GenerateRequest {
  // …existing fields…
  referencePaths?: string[];
  videoParentId?: string;
}
```

And in `generate()` include `referencePaths: this.mode() === 'video' ? this.refSlots().map((s) => s.path) : undefined, videoParentId: this.videoParent()?.id`. After emitting, `this.refSlots.set([])` (keep `videoParent` — the user may extend again).

In `resolutionOptions` add a lite rule after the existing fast rule:

```ts
    if (f.id === 'veo' && this.settings().version === 'lite') return list.filter((o) => o.value !== '4K');
```

- [ ] **Step 5: `left-panel.html` changes**

Video mode button: `(click)="onVideoModeToggle()"`, title → `videoLocked() ? 'Video — Pro plan' : null`, icon `videoLocked() ? 'lucideLock' : 'lucideVideo'`, `[class.mode-locked]="videoLocked()"`.

Reference block: wrap the existing image reference `.field` in `@if (mode() === 'image' && family().capabilities.imageInput && !personaActive())`. After it add:

```html
        @if (showReferences()) {
          <div class="field">
            <app-reference-drop
              [mode]="videoMode()"
              [slots]="refSlots()"
              (slotsChanged)="refSlots.set($event)"
              (pickFromLibrary)="pickReferenceRequested.emit()"
            />
          </div>
        }
        @if (showVideoParent()) {
          <div class="field">
            @if (videoParent(); as parent) {
              <div class="parent-row">
                <span class="parent-name">{{ parent.familyName }} · {{ parent.durationS ?? parent.settings.durationS }}s</span>
                <button type="button" class="parent-change" (click)="pickVideoRequested.emit()">Change</button>
              </div>
            } @else {
              <button type="button" class="parent-pick" (click)="pickVideoRequested.emit()">
                <ng-icon name="lucideVideo" size="14" />
                Pick a finished video
              </button>
            }
          </div>
        }
```

Settings section, directly after the Model/Version group and before Aspect ratio:

```html
        @if (mode() === 'video') {
          <app-mode-picker [family]="family()" [selected]="videoMode()" (changed)="setVideoMode($event)" />
        }
```

Aspect ratio group: wrap in `@if (!hideAspect()) { … }`.

Batch group: wrap in `@if (mode() === 'image') { <div class="batch-group"> …existing… </div> }`.

Audio: replace `@if (family().capabilities.audio) { <p class="audio-note">…` with:

```html
        @if (audioSelectable()) {
          <div class="audio-group">
            <app-option-group
              label="Audio"
              axisTooltip="Soundtrack changes the price per second."
              [options]="audioOptions"
              [selected]="settings().audio ?? 'off'"
              (changed)="setAudio($event)"
            />
          </div>
        }
        @if (audioIncluded()) {
          <p class="audio-note">
            <app-hint text="This model generates a native soundtrack with every clip."><span>♪ Audio included</span></app-hint>
          </p>
        }
```

Generate button label: `×{{ batch() }}` → `@if (mode() === 'image') { ×{{ batch() }} }`.

- [ ] **Step 6: `left-panel.css`**

```css
.parent-row,
.parent-pick {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border: 1px dashed var(--border);
  border-radius: calc(var(--radius) - 2px);
  font-size: 12px;
  color: var(--muted-foreground);
  background: transparent;
}

.parent-pick {
  cursor: pointer;
  justify-content: center;
}

.parent-pick:hover {
  color: var(--foreground);
  border-color: var(--foreground);
}

.parent-name {
  flex: 1;
  color: var(--foreground);
}

.parent-change {
  background: none;
  border: none;
  color: var(--muted-foreground);
  font-size: 12px;
  cursor: pointer;
  text-decoration: underline;
}
```

- [ ] **Step 7: Wire the workspace page**

`workspace-page.ts`: add `VideoPickerDialog` to imports; add `readonly videoPickerOpen = signal(false);` and:

```ts
  onVideoPicked(item: GenerationItem): void {
    this.rail().setVideoParent(item);
    this.videoPickerOpen.set(false);
  }
```

In `onGenerate(req)`: keep the op logic; pass through `referencePaths: req.referencePaths` and, when `req.videoParentId`, `parentId: req.videoParentId`. Video always `op: GenerationOp.Generate` — the reference/uploadId→Edit rule must only apply to images: `const isImageEdit = req.settings.mode === undefined && (req.referenceId || req.uploadId) && !req.personaId;`.

`workspace-page.html`: on `<app-left-panel …>` add `(upgradeRequested)="upgradePlan()" (pickVideoRequested)="videoPickerOpen.set(true)"`. Next to the other dialogs:

```html
@if (videoPickerOpen()) {
  <app-video-picker-dialog
    [items]="generations()"
    [familyId]="rail().familyId()"
    (picked)="onVideoPicked($event)"
    (closed)="videoPickerOpen.set(false)"
  />
}
```

- [ ] **Step 8: Tests + build**

Run: `npm test -- --watch=false 2>&1 | tail -4`
Expected: `Tests  221 passed` (217 + 4).

Run: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npx ng build 2>&1 | tail -3`
Expected: success.

User commits.

---

### Task 19: `pending-video-card` (progress, phase, cancel)

**Files:**
- Create: `src/app/features/workspace/pending-video-card/pending-video-card.ts`
- Create: `src/app/features/workspace/pending-video-card/pending-video-card.html`
- Create: `src/app/features/workspace/pending-video-card/pending-video-card.css`
- Modify: `src/app/features/workspace/library-grid/library-grid.ts` + `.html` (use the card for pending videos; add `cancel` output)
- Modify: `src/app/features/workspace/workspace-page.ts` + `.html` (`onCancel`)
- Test: `src/app/features/workspace/pending-video-card/pending-video-card.spec.ts`

**Interfaces:**
- Produces: `<app-pending-video-card [item] [now] (cancel)>` — `item: GenerationItem` (required), `now: number` (ms, required; parent passes a ticking signal so the card stays pure), `cancel: string` (generation id). Exported pure helpers `easedProgress(elapsedS, expectedS, reported?: number): number` (0–0.9 unless reported ≥ 0.9) and `phaseLabel(phase, elapsedS, expectedS): string`.

Copy (spec): phases `Queued` / `Rendering` / `Saving`; eased to 90 % then `Almost there…`; over 2× expected: `Taking longer than usual — still working.`; always `You can leave this page. We'll notify you when it's ready.`

- [ ] **Step 1: Spec**

```ts
import { TestBed } from '@angular/core/testing';
import type { GenerationItem } from '../../../core/generations/generation-store';
import { PendingVideoCard, easedProgress, phaseLabel } from './pending-video-card';

const started = Date.parse('2026-09-06T10:00:00Z');

function pending(job: Partial<GenerationItem['job']> = {}): GenerationItem {
  return {
    id: 'v1', kind: 'video', familyId: 'veo', familyName: 'Veo 3.1', op: 'generate', prompt: 'p', settings: { aspectRatio: '16:9', durationS: 8 },
    priceCredits: 534, status: 'pending', mediaUrl: '', parentId: null, createdAt: new Date(started).toISOString(),
    job: { cancellable: true, expectedS: 96, startedAt: new Date(started).toISOString(), phase: 'rendering', ...job },
  } as GenerationItem;
}

describe('pending video helpers', () => {
  it('easedProgress climbs to 0.9 and never beyond without a report', () => {
    expect(easedProgress(0, 96)).toBe(0);
    expect(easedProgress(48, 96)).toBeGreaterThan(0.4);
    expect(easedProgress(48, 96)).toBeLessThan(0.9);
    expect(easedProgress(500, 96)).toBe(0.9);
    expect(easedProgress(10, 96, 0.95)).toBe(0.95);
  });

  it('phaseLabel', () => {
    expect(phaseLabel('queued', 5, 96)).toBe('Queued');
    expect(phaseLabel('rendering', 5, 96)).toBe('Rendering');
    expect(phaseLabel('rendering', 100, 96)).toBe('Almost there…');
    expect(phaseLabel('rendering', 200, 96)).toBe('Taking longer than usual — still working.');
    expect(phaseLabel('saving', 300, 96)).toBe('Saving');
  });
});

describe('PendingVideoCard', () => {
  function make(item: GenerationItem, nowMs: number) {
    const fixture = TestBed.createComponent(PendingVideoCard);
    fixture.componentRef.setInput('item', item);
    fixture.componentRef.setInput('now', nowMs);
    fixture.detectChanges();
    return fixture;
  }

  it('shows phase, eased bar and leave-note', () => {
    const fixture = make(pending(), started + 48_000);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.pv-phase')!.textContent).toContain('Rendering');
    expect(el.querySelector('.pv-note')!.textContent).toContain('You can leave this page');
    const bar = el.querySelector('.pv-bar-fill') as HTMLElement;
    expect(bar.style.getPropertyValue('--p')).not.toBe('');
  });

  it('shows queue position and hides cancel when not cancellable', () => {
    const fixture = make(pending({ phase: 'queued', queuePosition: 4, cancellable: false }), started + 1000);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.pv-phase')!.textContent).toContain('4 ahead');
    expect(el.querySelector('.pv-cancel')).toBeNull();
  });

  it('emits cancel', () => {
    const fixture = make(pending(), started + 1000);
    const ids: string[] = [];
    fixture.componentInstance.cancel.subscribe((id) => ids.push(id));
    (fixture.nativeElement.querySelector('.pv-cancel') as HTMLButtonElement).click();
    expect(ids).toEqual(['v1']);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- --watch=false 2>&1 | grep -E "pending-video|Tests"`
Expected: cannot resolve `./pending-video-card`.

- [ ] **Step 3: `pending-video-card.ts`**

```ts
import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideX } from '@ng-icons/lucide';
import type { JobPhase } from '../../../core/api/dtos';
import type { GenerationItem } from '../../../core/generations/generation-store';

const EASE_CAP = 0.9;
const LATE_FACTOR = 2;

/** Ease-out toward 0.9 over expectedS; a real report ≥ eased value wins. */
export function easedProgress(elapsedS: number, expectedS: number, reported?: number): number {
  const t = Math.min(1, Math.max(0, elapsedS / Math.max(1, expectedS)));
  const eased = EASE_CAP * (1 - Math.pow(1 - t, 2.2));
  const rounded = Math.round(eased * 1000) / 1000;
  if (reported === undefined) return Math.min(EASE_CAP, rounded);
  return Math.max(rounded, Math.min(1, reported));
}

export function phaseLabel(phase: JobPhase | undefined, elapsedS: number, expectedS: number): string {
  if (phase === 'saving') return 'Saving';
  if (phase === 'queued') return 'Queued';
  if (elapsedS > expectedS * LATE_FACTOR) return 'Taking longer than usual — still working.';
  if (elapsedS > expectedS) return 'Almost there…';
  return 'Rendering';
}

@Component({
  selector: 'app-pending-video-card',
  imports: [NgIcon],
  providers: [provideIcons({ lucideX })],
  templateUrl: './pending-video-card.html',
  styleUrl: './pending-video-card.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PendingVideoCard {
  readonly item = input.required<GenerationItem>();
  readonly now = input.required<number>();
  readonly cancel = output<string>();

  private readonly job = computed(() => this.item().job);
  readonly elapsedS = computed(() => {
    const start = Date.parse(this.job()?.startedAt ?? this.item().createdAt);
    return Math.max(0, (this.now() - start) / 1000);
  });
  readonly expectedS = computed(() => this.job()?.expectedS ?? 60);
  readonly progress = computed(() => easedProgress(this.elapsedS(), this.expectedS(), this.job()?.progress));
  readonly percent = computed(() => Math.round(this.progress() * 100));
  readonly phase = computed(() => phaseLabel(this.job()?.phase, this.elapsedS(), this.expectedS()));
  readonly queueAhead = computed(() => {
    const q = this.job()?.queuePosition;
    if (this.job()?.phase !== 'queued' || q === undefined) return '';
    return ` · ${q} ahead`;
  });
  readonly cancellable = computed(() => this.job()?.cancellable ?? false);
  readonly eta = computed(() => {
    const left = Math.max(0, this.expectedS() - this.elapsedS());
    if (this.elapsedS() > this.expectedS()) return '';
    return `~${Math.ceil(left / 10) * 10}s`;
  });
}
```

- [ ] **Step 4: `pending-video-card.html`**

```html
<div class="pv">
  <div class="pv-top">
    <span class="pv-phase">{{ phase() }}{{ queueAhead() }}</span>
    @if (eta()) {
      <span class="pv-eta">{{ eta() }}</span>
    }
  </div>
  <div class="pv-bar" role="progressbar" [attr.aria-valuenow]="percent()" aria-valuemin="0" aria-valuemax="100">
    <div class="pv-bar-fill" [style.--p]="progress()"></div>
  </div>
  <p class="pv-note">You can leave this page. We'll notify you when it's ready.</p>
  @if (cancellable()) {
    <button type="button" class="pv-cancel" (click)="cancel.emit(item().id)">
      <ng-icon name="lucideX" size="12" />
      Cancel · refund {{ item().priceCredits }} cr
    </button>
  }
</div>
```

(`[style.--p]` is the one inline style allowed here: it is a CSS custom property driven by state, consumed by the stylesheet.)

- [ ] **Step 5: `pending-video-card.css`**

```css
.pv {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px;
  background: linear-gradient(180deg, #1a1a1a, #0d0d0d);
  color: #e8e8e8;
}

.pv-top {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
}

.pv-eta {
  color: #9a9a9a;
}

.pv-bar {
  height: 4px;
  border-radius: 2px;
  background: rgb(255 255 255 / 0.12);
  overflow: hidden;
}

.pv-bar-fill {
  height: 100%;
  width: calc(var(--p) * 100%);
  background: #fff;
  transition: width 600ms ease-out;
}

.pv-note {
  font-size: 11px;
  color: #9a9a9a;
}

.pv-cancel {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border: 1px solid rgb(255 255 255 / 0.2);
  border-radius: 4px;
  background: transparent;
  color: #ddd;
  font-size: 11px;
  cursor: pointer;
}

.pv-cancel:hover {
  border-color: #fff;
  color: #fff;
}
```

- [ ] **Step 6: Use it in `library-grid`**

`library-grid.ts`: import `PendingVideoCard`; add `readonly cancel = output<string>();` and a ticking clock:

```ts
  readonly now = signal(Date.now());
  private readonly clock = setInterval(() => this.now.set(Date.now()), 1000);
  ngOnDestroy(): void { clearInterval(this.clock); }
```

(implement `OnDestroy`). `library-grid.html`: replace the pending branch:

```html
          @if (item.status === 'pending' && item.kind === 'video') {
            <app-pending-video-card [item]="item" [now]="now()" (cancel)="cancel.emit($event)" />
          } @else if (item.status === 'pending') {
            <div class="gen-pending"><span class="spinner"></span>Generating…</div>
          } @else if (item.status === 'failed') {
```

`workspace-page.html`: add `(cancel)="onCancel($event)"` to `<app-library-grid>`. `workspace-page.ts`:

```ts
  async onCancel(id: string): Promise<void> {
    try {
      const refunded = await this.store.cancel(id);
      this.notice.set(`Cancelled. Refunded ${refunded} cr.`);
    } catch (e) {
      this.showError(e, 'Could not cancel');
    }
  }
```

In `showError`, map codes to spec copy (add cases next to the existing moderation mapping):

```ts
const VIDEO_ERROR_COPY: Record<string, string> = {
  provider_blocked: 'Provider declined this prompt. Credits refunded.',
  too_many_jobs: '3 videos are still rendering — wait for one to finish',
  unsupported_mode: "This model can't do that mode.",
  bad_parent: 'Pick a finished video to extend or edit.',
  not_cancellable: "This model can't be cancelled once started.",
  bad_reference_count: 'Add the reference images this mode needs.',
};
```

and for `daily_cap`: `const h = Math.max(1, Math.ceil((Date.parse(err.resetsAt) - Date.now()) / 3_600_000)); this.notice.set(\`Daily video limit reached, resets in ${h}h\`)`. Also in `GenerationStore.applyJobUpdates`, the refund event detail for a failed video should surface `provider_blocked`: the DTO has no error field, so keep the generic refund toast (`Refunded N credits`); the `provider_blocked` copy above is used when the submit itself fails synchronously.

- [ ] **Step 7: Tests + build**

Run: `npm test -- --watch=false 2>&1 | tail -4`
Expected: `Tests  226 passed` (221 + 5).

Run the build command; expected success.

User commits.

---

### Task 20: `rendering-chip`, tab title, toast "View"

**Files:**
- Create: `src/app/features/workspace/rendering-chip/rendering-chip.ts` / `.html` / `.css`
- Modify: `src/app/features/workspace/workspace-page.ts` + `.html` (`.topbar-right`)
- Modify: `src/app/core/notifications/notification-toast.html` (button label)
- Test: `src/app/features/workspace/rendering-chip/rendering-chip.spec.ts`

**Interfaces:**
- Produces: `<app-rendering-chip [count] />` — `count: number` (required); renders nothing when 0; text `Rendering 1 video` / `Rendering N videos`. `workspace-page` sets `document.title` via `effect` to `(n) Rendering… · Vansen` while `pendingVideoCount() > 0`, restoring the previous title after.

- [ ] **Step 1: Spec**

```ts
import { TestBed } from '@angular/core/testing';
import { RenderingChip } from './rendering-chip';

describe('RenderingChip', () => {
  function make(count: number) {
    const fixture = TestBed.createComponent(RenderingChip);
    fixture.componentRef.setInput('count', count);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('renders nothing at zero', () => {
    expect(make(0).querySelector('.rchip')).toBeNull();
  });

  it('pluralises', () => {
    expect(make(1).textContent).toContain('Rendering 1 video');
    expect(make(3).textContent).toContain('Rendering 3 videos');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- --watch=false 2>&1 | grep -E "rendering-chip|Tests"`
Expected: cannot resolve.

- [ ] **Step 3: Component**

`rendering-chip.ts`:

```ts
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

@Component({
  selector: 'app-rendering-chip',
  templateUrl: './rendering-chip.html',
  styleUrl: './rendering-chip.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RenderingChip {
  readonly count = input.required<number>();
  readonly label = computed(() => `Rendering ${this.count()} ${this.count() === 1 ? 'video' : 'videos'}`);
}
```

`rendering-chip.html`:

```html
@if (count() > 0) {
  <span class="rchip" role="status">
    <span class="spinner"></span>
    {{ label() }}
  </span>
}
```

`rendering-chip.css`:

```css
.rchip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 36px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: calc(var(--radius) - 2px);
  font-size: 12px;
  color: var(--muted-foreground);
  white-space: nowrap;
}

.spinner {
  width: 10px;
  height: 10px;
  border: 1.5px solid var(--border);
  border-top-color: var(--foreground);
  border-radius: 50%;
  animation: spin 800ms linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
```

- [ ] **Step 4: Wire into the top bar + title**

`workspace-page.html` — inside `<div class="topbar-right">`, before `<app-notification-bell …>`:

```html
      <app-rendering-chip [count]="pendingVideoCount()" />
```

`workspace-page.ts`: import `RenderingChip` (add to `imports`), `effect` from `@angular/core`, and:

```ts
  readonly pendingVideoCount = this.store.pendingVideoCount;
  private readonly baseTitle = document.title;
  private readonly titleEffect = effect(() => {
    const n = this.pendingVideoCount();
    document.title = n > 0 ? `(${n}) Rendering… · ${this.baseTitle}` : this.baseTitle;
  });
```

- [ ] **Step 5: Toast "View"**

In `notification-toast.html`, the action button that emits `open` currently reads `Open` (or similar) — change its label to `View`. If the toast has no action button, add one inside the toast body:

```html
  <button type="button" class="toast-view" (click)="open.emit(n.genId!)">View</button>
```

with `.toast-view` styled like the existing toast link (`notification-toast.css`).

- [ ] **Step 6: Tests + build**

Run: `npm test -- --watch=false 2>&1 | tail -4`
Expected: `Tests  228 passed` (226 + 2).

Build: success.

User commits.

---

### Task 21: Client poster generation + grid video tile

**Files:**
- Create: `src/app/core/media/poster-service.ts`
- Modify: `src/app/features/workspace/library-grid/library-grid.ts` + `.html` + `.css`
- Test: `src/app/core/media/poster-service.spec.ts`

**Interfaces:**
- Consumes: `ApiService.postForm<ThumbResponse>`, `GenerationStore.setThumb`.
- Produces:
  ```ts
  @Injectable({ providedIn: 'root' }) export class PosterService {
    ensure(item: GenerationItem): void;              // fire-and-forget; one attempt per id per session
    captureFrame(url: string, atS?: number): Promise<Blob>;  // hidden <video> → canvas → JPEG 0.8
  }
  export const POSTER_MAX_BYTES = 512 * 1024;
  ```

- [ ] **Step 1: Spec**

```ts
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { ApiService } from '../api/api-service';
import { GenerationStore, type GenerationItem } from '../generations/generation-store';
import { POSTER_MAX_BYTES, PosterService } from './poster-service';

function video(overrides: Partial<GenerationItem> = {}): GenerationItem {
  return {
    id: 'v1', kind: 'video', familyId: 'veo', familyName: 'Veo', op: 'generate', prompt: 'p', settings: { aspectRatio: '16:9' },
    priceCredits: 1, status: 'done', mediaUrl: 'https://m/v1.mp4', parentId: null, createdAt: 'x', ...overrides,
  } as GenerationItem;
}

describe('PosterService', () => {
  const api = { postForm: vi.fn() };
  const store = { setThumb: vi.fn() };

  function make() {
    TestBed.configureTestingModule({
      providers: [{ provide: ApiService, useValue: api }, { provide: GenerationStore, useValue: store }],
    });
    const svc = TestBed.inject(PosterService);
    vi.spyOn(svc, 'captureFrame').mockResolvedValue(new Blob([new Uint8Array(10)], { type: 'image/jpeg' }));
    return svc;
  }

  beforeEach(() => {
    api.postForm.mockReset();
    store.setThumb.mockReset();
  });

  it('uploads a poster once for a done video without thumb', async () => {
    api.postForm.mockResolvedValue({ thumbUrl: 'https://t/v1.jpg' });
    const svc = make();
    svc.ensure(video());
    svc.ensure(video());
    await Promise.resolve();
    await Promise.resolve();
    expect(api.postForm).toHaveBeenCalledTimes(1);
    expect(api.postForm).toHaveBeenCalledWith('/generations/v1/thumb', expect.any(FormData));
    expect(store.setThumb).toHaveBeenCalledWith('v1', 'https://t/v1.jpg');
  });

  it('skips items that already have a thumb, are pending, or are images', () => {
    const svc = make();
    svc.ensure(video({ thumbUrl: 'https://t/x.jpg' }));
    svc.ensure(video({ status: 'pending' }));
    svc.ensure(video({ kind: 'image' }));
    expect(svc.captureFrame).not.toHaveBeenCalled();
  });

  it('skips oversized frames', async () => {
    const svc = make();
    (svc.captureFrame as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Blob([new Uint8Array(POSTER_MAX_BYTES + 1)], { type: 'image/jpeg' }),
    );
    svc.ensure(video());
    await Promise.resolve();
    await Promise.resolve();
    expect(api.postForm).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- --watch=false 2>&1 | grep -E "poster-service|Tests"`
Expected: cannot resolve `./poster-service`.

- [ ] **Step 3: `poster-service.ts`**

```ts
import { inject, Injectable } from '@angular/core';
import { ApiService } from '../api/api-service';
import type { ThumbResponse } from '../api/dtos';
import { GenerationStore, type GenerationItem } from '../generations/generation-store';

export const POSTER_MAX_BYTES = 512 * 1024;
const SEEK_S = 0.5;
const JPEG_QUALITY = 0.8;
const LOAD_TIMEOUT_MS = 15_000;

@Injectable({ providedIn: 'root' })
export class PosterService {
  private readonly api = inject(ApiService);
  private readonly store = inject(GenerationStore);
  private readonly attempted = new Set<string>();

  /** Generate + upload a poster for a finished video that has none. One attempt per id per session. */
  ensure(item: GenerationItem): void {
    if (item.kind !== 'video' || item.status !== 'done' || item.thumbUrl || !item.mediaUrl) return;
    if (this.attempted.has(item.id)) return;
    this.attempted.add(item.id);
    void this.run(item);
  }

  private async run(item: GenerationItem): Promise<void> {
    try {
      const blob = await this.captureFrame(item.mediaUrl, SEEK_S);
      if (blob.size > POSTER_MAX_BYTES) return;
      const form = new FormData();
      form.append('file', blob, `${item.id}.jpg`);
      const res = await this.api.postForm<ThumbResponse>(`/generations/${item.id}/thumb`, form);
      this.store.setThumb(item.id, res.thumbUrl);
    } catch {
      // Fallback tile is fine; never retry this session.
    }
  }

  captureFrame(url: string, atS = SEEK_S): Promise<Blob> {
    return new Promise<Blob>((resolve, reject) => {
      const video = document.createElement('video');
      video.crossOrigin = 'anonymous';
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      const timer = setTimeout(() => finish(new Error('poster timeout')), LOAD_TIMEOUT_MS);

      const finish = (err: Error | null, blob?: Blob) => {
        clearTimeout(timer);
        video.removeAttribute('src');
        video.load();
        if (err || !blob) {
          reject(err ?? new Error('poster failed'));
          return;
        }
        resolve(blob);
      };

      video.addEventListener('loadedmetadata', () => {
        video.currentTime = Math.min(atS, Math.max(0, video.duration - 0.1));
      });
      video.addEventListener('seeked', () => {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          finish(new Error('no 2d context'));
          return;
        }
        ctx.drawImage(video, 0, 0);
        canvas.toBlob((b) => finish(b ? null : new Error('toBlob null'), b ?? undefined), 'image/jpeg', JPEG_QUALITY);
      });
      video.addEventListener('error', () => finish(new Error('video load error')));
      video.src = url;
    });
  }
}
```

R2 presigned URLs must allow CORS for `drawImage` to not taint the canvas: in the Cloudflare dashboard set the bucket CORS policy to allow `GET` from the app origin(s) with `Access-Control-Allow-Origin` (part of Task 24 rollout).

- [ ] **Step 4: Grid tile**

`library-grid.ts`: inject `PosterService`; add `readonly poster = inject(PosterService);`. In `library-grid.html`, the non-pending, non-failed branch becomes:

```html
          } @else if (item.kind === 'video') {
            <div class="video-tile" (pointerenter)="poster.ensure(item)">
              @if (item.thumbUrl) {
                <img [src]="item.thumbUrl" [alt]="item.prompt" loading="lazy" />
              } @else {
                <div class="video-dark"></div>
              }
              <span class="video-play"><ng-icon name="lucidePlay" size="18" /></span>
              <span class="video-tag">{{ item.durationS ?? item.settings.durationS }}s</span>
            </div>
            …existing .qa-overlay…
          } @else {
            …existing img + .qa-overlay…
          }
```

Also call `poster.ensure(item)` when the item first renders: add to `library-grid.ts` an `effect` that runs `for (const i of this.items()) this.poster.ensure(i);` — the service dedupes. Add `lucidePlay` to `provideIcons`.

`library-grid.css`:

```css
.video-tile {
  position: relative;
  width: 100%;
  height: 100%;
}

.video-tile img,
.video-dark {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.video-dark {
  background: linear-gradient(180deg, #202020, #0e0e0e);
}

.video-play {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #fff;
  opacity: 0.85;
  pointer-events: none;
}
```

Keep the existing `.video-tag` rule.

- [ ] **Step 5: Tests + build**

Run: `npm test -- --watch=false 2>&1 | tail -4`
Expected: `Tests  231 passed` (228 + 3).

Build: success.

User commits.

---

### Task 22: Detail overlay — video player, Extend / Edit actions

**Files:**
- Modify: `src/app/features/workspace/detail-overlay/detail-overlay.ts` + `.html` + `.css`
- Modify: `src/app/features/workspace/workspace-page.ts` + `.html`
- Modify: `src/app/features/workspace/left-panel/left-panel.ts` (`startVideoFollowUp`)

**Interfaces:**
- Produces: `DetailOverlay` outputs `extend: GenerationItem`, `editVideo: GenerationItem`. `LeftPanel.startVideoFollowUp(item: GenerationItem, mode: 'extend' | 'edit'): void` switches to video mode, selects a family that supports the mode (prefers the item's own family), sets the mode and parent.

- [ ] **Step 1: Overlay template**

In `detail-overlay.html` replace the `.preview` content:

```html
      <div class="preview">
        @if (item().kind === 'video') {
          <video
            class="preview-video"
            controls
            playsinline
            preload="metadata"
            [poster]="item().thumbUrl ?? null"
            [src]="item().mediaUrl"
          ></video>
        } @else {
          <img [cachedSrc]="item().mediaUrl" [cacheKey]="item().id" [alt]="item().prompt" />
        }
      </div>
```

Action column: the existing `@if (item().kind === 'image')` block (Upscale / Variation / Edit →) stays. Add after it:

```html
          @if (item().kind === 'video' && item().status === 'done') {
            @if (canExtend()) {
              <button type="button" class="action" [disabled]="busy()" (click)="extend.emit(item())">Extend →</button>
            }
            @if (canEditVideo()) {
              <button type="button" class="action" [disabled]="busy()" (click)="editVideo.emit(item())">Edit →</button>
            }
          }
```

Add a duration fact to `.meta-facts` when video: `<dt>Length</dt><dd>{{ item().durationS ?? item().settings.durationS }}s</dd>`.

- [ ] **Step 2: Overlay class**

```ts
  readonly extend = output<GenerationItem>();
  readonly editVideo = output<GenerationItem>();

  readonly canExtend = computed(() => MODEL_FAMILIES.some((f) => videoFamilySupports(f, 'extend')));
  readonly canEditVideo = computed(() => this.item().familyId === 'omni');
```

Imports: `MODEL_FAMILIES, videoFamilySupports` from `'../../../core/catalog/model-families'`. Hide the Studio-Edit entry for video: it already sits inside the `kind === 'image'` block, so nothing else to do.

- [ ] **Step 3: CSS**

`detail-overlay.css`:

```css
.preview-video {
  max-width: 100%;
  max-height: 100%;
  background: #000;
  border-radius: calc(var(--radius) - 2px);
}
```

- [ ] **Step 4: Left panel follow-up entry point**

`left-panel.ts`:

```ts
  startVideoFollowUp(item: GenerationItem, mode: 'extend' | 'edit'): void {
    this.setMode('video');
    const own = familyById(item.familyId);
    const target = own && videoFamilySupports(own, mode) ? own : MODEL_FAMILIES.find((f) => f.kind === 'video' && videoFamilySupports(f, mode));
    if (!target) return;
    this.familyId.set(target.id);
    this.clampSettings();
    this.setVideoMode(mode);
    this.videoParent.set(item);
  }
```

(Use the same family-setting method Task 18 uses if it is not `familyId.set`.)

- [ ] **Step 5: Workspace wiring**

`workspace-page.html` on `<app-detail-overlay …>` add `(extend)="onVideoFollowUp($event, 'extend')" (editVideo)="onVideoFollowUp($event, 'edit')"`. `workspace-page.ts`:

```ts
  onVideoFollowUp(item: GenerationItem, mode: 'extend' | 'edit'): void {
    this.openedId.set(null);
    this.rail().startVideoFollowUp(item, mode);
  }
```

- [ ] **Step 6: Build + tests**

Run: `npm test -- --watch=false 2>&1 | tail -4` → `Tests  231 passed`.
Build: success. Manually: open a done video in the overlay, confirm `<video controls>` renders and Extend appears.

User commits.

---

### Task 23: Preferences — default video mode

**Files:**
- Modify: `src/app/core/preferences/preferences-service.ts`
- Modify: `src/app/features/settings/preferences-tab/preferences-tab.ts` + `.html`
- Modify: `src/app/features/workspace/left-panel/left-panel.ts` (apply pref when entering video mode)
- Modify: `supabase/functions/api/index.ts` (`PREF_CHECKS` L133–141)
- Test: existing `preferences-service.spec.ts` if present, else `left-panel.spec.ts`

**Interfaces:**
- Produces: `Prefs.defaultVideoMode: VideoMode` (default `'t2v'`); server accepts it.

- [ ] **Step 1: Test**

In `left-panel.spec.ts` add `defaultVideoMode: 'i2v'` to `PREFS` and:

```ts
  it('applies the default video mode when switching to video', () => {
    const { fixture, component } = makeComponent();
    component.setMode('video');
    fixture.detectChanges();
    expect(component.videoMode()).toBe('i2v');
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- --watch=false 2>&1 | grep -E "left-panel|Tests"`
Expected: 1 failure (mode is `t2v`).

- [ ] **Step 3: Service**

`preferences-service.ts`: add `defaultVideoMode: VideoMode;` to `Prefs` (import `VideoMode`), `defaultVideoMode: 't2v'` to `DEFAULTS`.

- [ ] **Step 4: Left panel**

In `setMode(mode)`, after switching to video and choosing the family:

```ts
    if (mode !== 'video') return;
    const preferred = this.prefsService.prefs().defaultVideoMode;
    if (videoFamilySupports(this.family(), preferred)) this.setVideoMode(preferred);
```

- [ ] **Step 5: Settings tab**

`preferences-tab.ts`: `readonly videoModes = Object.entries(MODE_LABELS) as [VideoMode, string][];` (import `MODE_LABELS` from the mode-picker) and `setVideoMode(v: string): void { this.prefsService.update({ defaultVideoMode: v as VideoMode }); }`.

`preferences-tab.html`, after the "Default video model" item + divider:

```html
    <div class="pref-item">
      <div class="pref-text">
        <label hlmLabel for="prefVideoMode">Default video mode</label>
        <p class="muted small">What the video rail starts on.</p>
      </div>
      <select id="prefVideoMode" class="pref-field pref-select" (change)="setVideoMode($any($event.target).value)">
        @for (m of videoModes; track m[0]) {
          <option [value]="m[0]" [selected]="prefs().defaultVideoMode === m[0]">{{ m[1] }}</option>
        }
      </select>
    </div>
    <div class="divider"></div>
```

- [ ] **Step 6: Server**

`PREF_CHECKS` gains:

```ts
  ['defaultVideoMode', (v) => typeof v === 'string' && ['t2v', 'i2v', 'ref2v', 'keyframes', 'extend', 'edit'].includes(v)],
```

- [ ] **Step 7: Tests + checks**

Run: `npm test -- --watch=false 2>&1 | tail -4` → `Tests  232 passed` (231 + 1).
Run: `cd supabase/functions && deno check api/index.ts; cd ../..` → clean.
Build: success.

User commits.

---

### Task 24: Rollout, smoke, docs

**Files:**
- Modify: `vansen.md` (video section), `CLAUDE.md` (Backend bullet "Video = Phase 4b, locked teaser" → live description), `docs/superpowers/punchlist.md` (header counts, ⏸️ L74–75 → ✅)

**Interfaces:** none.

- [ ] **Step 1: Secrets + bucket (user does these; agent verifies)**

User creates R2 bucket `vansen-media` (Cloudflare → R2), an API token with Object Read & Write on that bucket, and sets CORS on the bucket:

```json
[{ "AllowedOrigins": ["https://<prod-origin>", "http://localhost:4200"], "AllowedMethods": ["GET", "HEAD"], "AllowedHeaders": ["*"], "MaxAgeSeconds": 3600 }]
```

Then:

```bash
supabase secrets set RUNWAY_API_KEY=… R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… R2_BUCKET=vansen-media
```

Verify: `supabase secrets list | grep -E "RUNWAY|R2_"` → five rows.

- [ ] **Step 2: Deploy**

```bash
supabase functions deploy api --no-verify-jwt
```

Expected: `Deployed Functions on project bnorhcxhvxydkgvcxjad: api`. Note the new version number for the punchlist.

- [ ] **Step 3: Smoke, one family at a time (cheapest settings)**

For each family, enable via MCP `execute_sql`: `update public.models set enabled = true where id = '<id>';`, then in the app (Pro account): generate with the cheapest settings, watch phases → done → plays in overlay → poster appears in grid → cancel a second job (fal/runway) → confirm refund toast. Order and settings:

| Family | Settings | Expected provider cost |
|---|---|---|
| omni | 360p · 4 s · t2v | $0.12 |
| veo | lite · 720p · 4 s · t2v | $0.20 |
| kling | 5 s · audio off · t2v | $0.56 |
| runway | 720p · 5 s · t2v | $0.60 |
| seedance | 480p · 5 s · t2v | $1.10 |

Also one i2v (runway) and one Omni edit chained from the Omni t2v. If a family fails on payload shape, fix the adapter + its `_test.ts`, redeploy, retry. Leave a family disabled if it cannot be made to work; note it in the punchlist.

Check the Edge Function logs during the R2 save for `store_failed`. Check R2 dashboard: `videos/<uid>/<gen>.mp4` and `.jpg` exist.

- [ ] **Step 4: Docs**

`CLAUDE.md` — replace the sentence `Video = Phase 4b, locked teaser.` with:

```
Video (Phase 4b, live): five families veo/omni (Google, no cancel), kling/seedance (fal), runway
(direct) in `_shared/providers/`; modes t2v/i2v/ref2v/keyframes/extend/edit gated by
`capabilities.modes`; Pro-only; caps = 3 pending videos + $40/day provider spend
(`VIDEO_DAILY_CAP_USD`). Files stream to Cloudflare R2 (`_shared/storage/`, secrets R2_*),
posters are client-captured JPEGs via `POST /generations/:id/thumb`. Cancel =
`POST /jobs/:id/cancel` (fal queued-only, runway any). Stale sweep: video 30 min.
Secrets: RUNWAY_API_KEY, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET.
```

`vansen.md` — add a "Video" subsection under the product features mirroring the spec's user-facing behaviour (modes, waiting UX copy, caps, refunds). `docs/superpowers/punchlist.md` — header counts (`232 vitest + 40 deno`, api version), move the Video ⏸️ item into ✅ with the date, add any families left disabled to 🟡.

- [ ] **Step 5: Final verification**

```bash
npm test -- --watch=false 2>&1 | tail -4
cd supabase/functions && deno test --allow-all _shared; cd ../..
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npx ng build 2>&1 | tail -3
```

Expected: `Tests  232 passed`, `ok | 40 passed`, build success.

User commits.
