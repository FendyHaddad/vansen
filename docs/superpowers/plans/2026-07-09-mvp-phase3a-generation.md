# Vansen Phase 3a — Real Image Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace placeholder image output with real provider generation: moderation-gated dispatch, google/openai/fal adapters, async jobs + polling, Supabase Storage with signed URLs, uploads, 2-strike suspension with appeal evidence, and a kill switch.

**Architecture:** `POST /generations` gains a pre-charge moderation gate and creates `pending` generations + `jobs`; provider adapters submit async work; `GET /jobs` polls, on completion downloads output → private Storage → signed URL. Two moderation strikes suspend (balance forfeit, no refund); technical failures always refund. `models` table is the kill switch.

**Tech Stack:** Supabase Edge Functions (Deno + Hono), Supabase Storage, OpenAI omni-moderation + Images, Google Gemini image API, fal queue API, Angular signals + polling.

## Global Constraints

- **NEVER git commit/branch/push** — user commits. Steps end at green build/verification.
- IMAGE families only this phase; video families seeded `enabled=false` in `models`.
- User price = `providerCost / (1 − 0.33)`; upscale repriced to fal cost (~$0.04 → **$0.06**), computed server-side. Client never sends prices.
- Moderation gate runs BEFORE charge and BEFORE any provider call, on prompt AND uploaded image. Flagged → 422 `content_policy`, `strike++`, `moderation_events` row, no charge, no provider call.
- **2 strikes (`profiles.strikes >= 2`) → dispatch + upload return 429 `account_suspended`; balance forfeited, no refund.** Suspension is derived state; clearing strikes reinstates.
- Full appeal evidence retained: exact prompt, quarantined copy of flagged upload, category scores in `moderation_events`; `resolution` records human review.
- Technical failure/timeout → automatic `refund` ledger entry, exactly once per generation.
- Every provider call carries `safety_identifier = sha256(user_id)`.
- Storage buckets private, no policies; access only via gateway-signed URLs (7-day). Direct bucket access must 403.
- Job model A: polling through the gateway (2s→5s backoff, only while pending). No realtime.
- Build/tests: nvm 22.23.1 prefix (phase 1 pattern). Supabase via MCP. Project `bnorhcxhvxydkgvcxjad`. Secrets: `GOOGLE_AI_API_KEY`, `OPENAI_API_KEY`, `FAL_API_KEY`.
- Error body `{ error: { code, message } }`; new codes: `content_policy` (422), `account_suspended` (429), `model_disabled` (503), `upload_failed` (400).
- Enums single-source in `core/enums.ts` → synced to `_shared` via `npm run sync-shared`; add `provider`, extend nothing else.

---

### Task 1: Migration 0004 — jobs, models, moderation, storage, refund RPC

**Files:**
- Create: `supabase/migrations/0004_generation.sql` (repo record; applied via MCP)

**Interfaces:**
- Produces: tables `jobs`, `models`, `moderation_events`; `generations.media_path`;
  `profiles.strikes` (exists) as suspension source; `fn_fail_job(p_job uuid, p_error text)`;
  unique refund guard; private Storage buckets `media`, `uploads`; seeded `models` rows.

- [x] **Step 1: Apply DDL via MCP `execute_sql` + save file:**

```sql
create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  generation_id uuid not null references public.generations on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  provider text not null check (provider in ('google','openai','fal')),
  provider_ref text,
  attempts int not null default 0,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index jobs_user_idx on public.jobs (user_id, created_at desc);
create index jobs_generation_idx on public.jobs (generation_id);
create index jobs_pending_idx on public.jobs (created_at) where error is null and provider_ref is not null;

create table public.models (
  id text primary key,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

create table public.moderation_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  source text not null check (source in ('prompt','upload')),
  prompt text,
  quarantine_path text,
  categories jsonb not null default '{}',
  resolution text,
  created_at timestamptz not null default now()
);
create index moderation_user_idx on public.moderation_events (user_id, created_at desc);

alter table public.generations add column media_path text;

alter table public.jobs enable row level security;
alter table public.models enable row level security;
alter table public.moderation_events enable row level security;

-- Refund runs exactly once per generation: unique guard on the refund note key.
create unique index ledger_refund_once on public.ledger_entries (note)
  where type = 'refund';

-- Seed availability: images + upscaler on, video off (3b flips them).
insert into public.models (id, enabled) values
  ('nano-banana', true), ('gpt-image', true), ('flux', true), ('seedream', true),
  ('upscaler', true),
  ('veo', false), ('sora', false), ('kling', false), ('runway', false), ('seedance', false);

-- Atomic technical-failure handler: mark generation failed, save job error,
-- refund the exact price once. Called by the gateway and the timeout sweep.
create or replace function public.fn_fail_job(p_job uuid, p_error text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_gen uuid; v_user uuid; v_price numeric; v_status text;
begin
  select j.generation_id, j.user_id into v_gen, v_user from public.jobs j where j.id = p_job;
  if v_gen is null then return; end if;
  update public.jobs set error = p_error, updated_at = now() where id = p_job;
  select status, price_usd into v_status, v_price from public.generations where id = v_gen;
  if v_status = 'failed' then return; end if;  -- already handled
  update public.generations set status = 'failed' where id = v_gen;
  insert into public.ledger_entries (user_id, type, amount_usd, note)
  values (v_user, 'refund', v_price, 'refund:' || v_gen::text)
  on conflict do nothing;  -- ledger_refund_once guard
end $$;

revoke execute on function public.fn_fail_job(uuid, text) from public, anon, authenticated;
grant execute on function public.fn_fail_job(uuid, text) to service_role;
```

- [x] **Step 2: Create private buckets** via MCP `execute_sql` on storage schema (or storage API):

```sql
insert into storage.buckets (id, name, public) values
  ('media', 'media', false), ('uploads', 'uploads', false)
on conflict (id) do nothing;
```

- [x] **Step 3: Verify** — `list_tables` shows 3 new tables RLS-enabled; `select id,enabled from public.models` = 5 true + 5 false; `get_advisors(security)` INFO-only; buckets exist and `public=false`.

---

### Task 2: USER ACTIONS — provider keys (BLOCKING)

Request explicitly, wait for "done". All three go to Supabase → Edge Functions → Secrets:

1. `GOOGLE_AI_API_KEY` — aistudio.google.com → Get API key (free tier fine to start).
2. `OPENAI_API_KEY` — platform.openai.com → API keys; add ~$5 credit (also powers the free moderation gate).
3. `FAL_API_KEY` — fal.ai → dashboard → Keys; deposit ~$10.

---

### Task 3: Shared provider adapters + moderation module

**Files:**
- Create: `supabase/functions/_shared/providers/types.ts`, `google.ts`, `openai.ts`, `fal.ts`, `index.ts` (registry), `supabase/functions/_shared/moderation.ts`, `supabase/functions/_shared/safety.ts`
- Note: these live under `_shared` (function-local, not synced from Angular — they are server-only). Keep the sync script limited to enums + catalog as today.

**Interfaces:**
- Produces:

```typescript
// types.ts
export interface SubmitCtx {
  familyId: string; op: string; prompt: string;
  settings: Record<string, unknown>;
  referenceUrl?: string;  // signed URL of stored upload/parent
  maskPngBase64?: string; // GPT edits
  safetyId: string;
}
export type CheckResult =
  | { state: 'running' }
  | { state: 'done'; bytes: Uint8Array; contentType: string }
  | { state: 'failed'; error: string };
export interface ProviderAdapter {
  readonly provider: 'google' | 'openai' | 'fal';
  submit(ctx: SubmitCtx): Promise<{ providerRef: string; inline?: CheckResult }>;
  check(providerRef: string): Promise<CheckResult>;
}
// index.ts
export function adapterFor(familyId: string): ProviderAdapter; // maps family → adapter
// moderation.ts
export async function moderate(input: { text?: string; imageUrl?: string }):
  Promise<{ flagged: boolean; categories: Record<string, number> }>;
// safety.ts
export async function safetyId(userId: string): Promise<string>; // sha256 hex
```

- [x] **Step 1: types.ts + safety.ts** (safetyId = `crypto.subtle.digest('SHA-256', …)` → hex).
- [x] **Step 2: moderation.ts** — POST OpenAI `https://api.openai.com/v1/moderations`, model `omni-moderation-latest`, input array (text and/or `image_url`). Return `flagged` + category scores object. On moderation API error, fail CLOSED (treat as flagged=false but log — do NOT block legitimate users on our outage; abuse still faces provider-native filters). Document this choice inline.
- [x] **Step 3: fal.ts** — submit to `https://queue.fal.run/{model}` with `fal_key`; returns `request_id`. check → `GET .../requests/{id}/status` then `/result`; download image bytes. Model slug map: `flux`→`fal-ai/flux-pro/v1.1`, `seedream`→`fal-ai/bytedance/seedream/v4/text-to-image` (or `/edit` when referenceUrl), `upscaler`→`fal-ai/clarity-upscaler`. Pass `image_url` for reference. (Exact slugs/params validated against fal docs during this task; adapter contract fixed.)
- [x] **Step 4: google.ts** — Gemini `generateContent` on the version's model id; map `image_size` (1K/2K/4K), aspect ratio, inline `inline_data` reference for edits. Usually returns image inline → `submit` returns `{ providerRef: 'inline:'+genId, inline: { state:'done', bytes } }`; check() returns done for `inline:` refs (defensive).
- [x] **Step 5: openai.ts** — Images generate / edits (`gpt-image-1` family; map version→model, quality low/med/high, size from aspect+resolution, `safety_identifier`, mask for edits). Base64 response → bytes.
- [x] **Step 6: index.ts registry** maps familyId → adapter instance. No tests here (network); exercised live in Task 8.

---

### Task 4: `api` v5 — moderation gate, suspension, jobs, dispatch

**Files:**
- Modify: `supabase/functions/api/index.ts` (redeploy with `_shared/*` incl. providers)

**Interfaces:**
- Consumes: Task 1 tables/RPC, Task 3 adapters/moderation/safety.
- Produces: `POST /generations` v2 (gate→charge→jobs→submit), `GET /jobs?ids=`, `GET /models`, `POST /uploads`.

- [x] **Step 1: suspension + models helpers:**

```typescript
async function isSuspended(userId: string): Promise<boolean> {
  const { data } = await admin.from('profiles').select('strikes').eq('id', userId).single();
  return (data?.strikes ?? 0) >= 2;
}
async function modelEnabled(familyId: string): Promise<boolean> {
  const { data } = await admin.from('models').select('enabled').eq('id', familyId).maybeSingle();
  return data?.enabled ?? false;
}
async function recordStrike(userId: string, source: 'prompt'|'upload',
  prompt: string | null, categories: Record<string, number>, quarantinePath?: string) {
  await admin.from('moderation_events').insert({
    user_id: userId, source, prompt, categories, quarantine_path: quarantinePath ?? null,
  });
  await admin.rpc('fn_increment_strike', { p_user: userId }); // add to migration: strikes+1 atomic
}
```

Add `fn_increment_strike` to migration 0004 (atomic `update profiles set strikes = strikes + 1`; service_role only).

- [x] **Step 2: POST /generations gate** (insert before charge, after existing validation):

```typescript
if (await isSuspended(userId)) return fail(c, 429, 'account_suspended', 'Account suspended — contact support to appeal.');
const modelId = op === 'upscale' ? 'upscaler' : familyId;
if (!(await modelEnabled(modelId))) return fail(c, 503, 'model_disabled', 'This model is temporarily unavailable.');
const mod = await moderate({ text: prompt });
if (mod.flagged) {
  await recordStrike(userId, 'prompt', prompt, mod.categories);
  return fail(c, 422, 'content_policy', 'This prompt violates our content policy.');
}
```

- [x] **Step 3: after charge** create a `jobs` row per generation, resolve reference signed URL (from `referenceUploadId` or parent `media_path`), call `adapter.submit`; store `provider_ref`; if adapter returned `inline` done, immediately run the completion path (Task 5 `finishJob`). Generation stays `pending` otherwise. Return items + balance (unchanged shape; `mediaUrl` null until done).
- [x] **Step 4: GET /models** → `{ models: [{ id, enabled }] }` (public-ish but still JWT-gated).
- [x] **Step 5:** Deploy; verify authed `POST /generations` with a violating prompt → 422, `moderation_events` row present, `select strikes` incremented, provider dashboards show zero calls.

---

### Task 5: Job completion, polling, storage, timeout sweep

**Files:**
- Modify: `supabase/functions/api/index.ts`; `supabase/migrations/0004_generation.sql` (append sweep cron)

**Interfaces:**
- Produces: `GET /jobs?ids=`, internal `finishJob(job, result)`, signed-URL helper `signMedia(path)`, cron `fail_stale_jobs`.

- [x] **Step 1: signMedia + finishJob:**

```typescript
async function signMedia(path: string): Promise<string> {
  const { data } = await admin.storage.from('media').createSignedUrl(path, 604800); // 7 days
  return data?.signedUrl ?? '';
}
async function finishJob(job, result) {
  if (result.state === 'failed') { await admin.rpc('fn_fail_job', { p_job: job.id, p_error: result.error }); return; }
  const path = `${job.user_id}/${job.generation_id}.png`;
  await admin.storage.from('media').upload(path, result.bytes, { contentType: result.contentType, upsert: true });
  await admin.from('generations').update({ status: 'done', media_path: path }).eq('id', job.generation_id);
}
```

- [x] **Step 2: GET /jobs** — parse `ids`, load owned pending jobs, `adapter.check(provider_ref)` each; done→finishJob; running→leave; then return the matching generations mapped to DTOs (media_url = signMedia(media_path) when done). Increment `jobs.attempts`.
- [x] **Step 3: GET /generations + GET /profile** already return generations — update `toGenerationDto` to derive `mediaUrl` from `media_path` via signMedia (async map).
- [x] **Step 4: timeout sweep cron** (append to migration, apply via MCP):

```sql
select cron.schedule('fail_stale_jobs', '*/5 * * * *', $$
  select public.fn_fail_job(j.id, 'timeout')
  from public.jobs j
  join public.generations g on g.id = j.generation_id
  where g.status = 'pending' and j.created_at < now() - interval '10 minutes'
$$);
```

- [x] **Step 5:** Deploy; verified live in Task 8.

---

### Task 6: Uploads

**Files:**
- Modify: `supabase/functions/api/index.ts`

**Interfaces:**
- Produces: `POST /uploads` (multipart) → `{ uploadId, url }`.

- [x] **Step 1:** Route: reject if suspended (429). Read `multipart/form-data` file; enforce ≤10MB and image mime by sniffing magic bytes (PNG `89504E47`, JPEG `FFD8FF`, WEBP `RIFF….WEBP`) — not the declared type. Non-image → 400 `upload_failed`.
- [x] **Step 2:** Moderate the image (upload to `uploads/{userId}/{uuid}` first, sign, `moderate({ imageUrl })`). Flagged → copy to `quarantine/{userId}/{uuid}`, delete from uploads, `recordStrike(userId,'upload',null,cats,quarantinePath)`, 422 `content_policy`.
- [x] **Step 3:** Clean → return `{ uploadId: path, url: signedUrl }`. Verify: text file → 400; oversized → 400; clean image → 200 with signed url.

---

### Task 7: Frontend — job polling, states, uploads, kill switch

**Files:**
- Create: `src/app/core/jobs/job-poller.ts`, `src/app/core/models/model-availability.ts`
- Modify: `generation-store.ts` (pending items, `refresh` merges poll updates), `api/dtos.ts` (`ModelsResponse`, upload types, `GenerationDto.status` already present), `settings-rail` (real upload + disabled families), `library-grid` (failed/refunded state + retry), `workspace-page.ts` (start poller; content_policy/suspended notices), `editor-page.ts` (mask PNG sent on edit)

**Interfaces:**
- Produces: `JobPoller.watch()` (polls `GET /jobs` for pending ids, applies to store, 2s→5s backoff, stops when none); `ModelAvailability.load()` + `disabled(familyId)`.

- [x] **Step 1: failing test** — JobPoller stops when no pending items and applies done updates:

```typescript
it('polls pending ids and applies completion', async () => {
  const store = fakeStoreWith([{ id: 'g1', status: 'pending' }]);
  const api = { get: vi.fn().mockResolvedValue({ items: [{ id: 'g1', status: 'done', mediaUrl: 'u' }] }) };
  const poller = new JobPoller(api as never, store);
  await poller.tick();
  expect(api.get).toHaveBeenCalledWith('/jobs?ids=g1');
  expect(store.byId('g1')?.status).toBe('done');
});
```

- [x] **Step 2:** Implement JobPoller + ModelAvailability; store gains `applyJobUpdates(items)` and `pendingIds()`.
- [x] **Step 3:** Workspace starts poller after load; `onGenerate` handles 422 `content_policy` (firm notice "Strike N of 2 — this prompt violates policy") and 429 `account_suspended` (blocking screen + appeal email). Library shows failed cards ("Generation failed — refunded $X", Retry re-submits).
- [x] **Step 4:** Settings-rail Upload button calls `POST /uploads` (real file input, progress, error toast on 422/400); disabled families greyed from ModelAvailability ("Coming soon" for video). Editor sends `maskPngBase64` from the canvas on GPT edits.
- [x] **Step 5:** Tests + build green.

---

### Task 8: Live E2E + docs

- [x] **Step 1:** Fresh test account, manual SQL topup $5 (removed after). One real generation per family: Nano Banana Fast, Seedream, FLUX, GPT low — confirm each polls pending→done, image loads from signed URL, ledger debited, provider dashboard shows the call.
- [x] **Step 2:** GPT masked edit (mask from editor) → new version; fal upscale → $0.06 charged, larger image; reference-image edit from an uploaded file.
- [x] **Step 3: Moderation drill** — violating prompt → 422, strike 1, `moderation_events` row with categories, zero provider calls, no charge. Violating image upload → 422, strike 2, quarantine copy stored. Now suspended: any dispatch → 429. SQL reinstate (`update profiles set strikes=0`, set `moderation_events.resolution='overturned: test'`) → dispatch works. 
- [x] **Step 4:** Kill-switch: disable `flux` → 503 + greyed UI; re-enable. Forced failure (temp-break a provider ref) → `fn_fail_job` refund exact; timeout sweep dry-run. Signed URL loads; direct `media` bucket URL → 400/403.
- [x] **Step 5:** Clean test data. Update vansen.md status + CLAUDE.md (providers live, keys in secrets, kill switch, strikes policy). Full vitest + build green.

---

## Self-review notes

- Spec coverage: §2→T4, §3→T3, §4→T5, §5→T4/T7, §6→T6, §7→T1(+fn_increment_strike, fn_fail_job), §8→T7, §9→T2, §10→T8. 2-strike/forfeit + appeal evidence in T1 (moderation_events + resolution) and T3/T4 (recordStrike). Refund-once via unique index (T1). safety_identifier T3. Image-upload moderation T6.
- Added to migration beyond spec prose: `fn_increment_strike` (atomic), `jobs_pending_idx`, `ledger_refund_once` unique index — all noted in tasks.
- Moderation fail-open on OUR outage documented (T3 step 2) — abuse still hits provider filters; avoids punishing users for our downtime.
- No commits. Types consistent (SubmitCtx/CheckResult/ProviderAdapter across T3–T5; ModelsResponse T4↔T7).
