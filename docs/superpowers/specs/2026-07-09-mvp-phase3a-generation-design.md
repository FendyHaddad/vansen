# Vansen MVP Phase 3a — Real Image Generation

Date: 2026-07-09
Status: approved in brainstorming; pending user review of this document
Prerequisites: Phases 1–2 live. Scope: IMAGE families only (Nano Banana, GPT Image,
FLUX, Seedream) + fal upscaler. Video (Veo/Sora/Kling/Runway/Seedance) = phase 3b,
shipped disabled via the kill switch.

## 1. Decisions (from brainstorming)

1. Providers now: **Google AI** (Nano Banana), **OpenAI** (GPT Image + free moderation
   endpoint), **fal.ai** (FLUX, Seedream, upscaler). Runway deferred to 3b.
2. **Upscale switches to fal** (clarity/creative upscaler); user price repriced to the
   standard formula: cost ~$0.04 → **$0.06**. Magnific ($0.25 via Runway) parked as a
   future "Premium upscale · $0.37" tier.
3. **Job model A: jobs table + client polling** through the gateway (2s → 5s backoff,
   poll only while pending). No realtime channel — one door stays one door. Polling
   cost analysis: free tier covers ~1K generations/day; ~$2–4/mo at 10K/day.
4. **Moderation policy (user-set):**
   - Gate everything BEFORE charge and BEFORE any provider call.
   - **2 strikes → suspended.** Dispatch returns 429 `account_suspended`. Remaining
     balance is forfeited (no refund on abuse suspension; ToS language in phase 4).
   - **Fairness/appeals:** AI moderators are fallible. Every flag stores full evidence
     (exact prompt, quarantined copy of any flagged upload, category scores) so a human
     can review and overturn. Appeal = manual for MVP (user emails support; admin
     reviews `moderation_events`, clears strikes via documented SQL runbook, outcome
     recorded in `moderation_events.resolution`). Suspension is derived state
     (`strikes >= 2`) — clearing strikes reinstates instantly.
5. Failed jobs (provider error/timeout) → automatic `refund` ledger entry for that
   job's exact price. (Distinct from abuse suspension — technical failures always
   refund.)

## 2. Dispatch pipeline (`POST /generations` v2)

```
validate (existing hardening) 
  → suspended? (strikes >= 2) → 429 account_suspended
  → MODERATION GATE (prompt + reference image if present)
      flagged → 422 content_policy · strike++ · moderation_events row
                NO charge · NO provider call
  → models.enabled check → 503 model_disabled if off
  → atomic charge + create generations rows (status pending) + jobs rows
  → adapter.submit() per item → provider_ref stored
  → return pending items + balance
```

- Moderation: OpenAI `omni-moderation-latest` (free, multimodal). Prompt text always;
  uploaded reference image checked at upload time (see §6) AND its stored copy
  referenced at dispatch.
- **Safety identifiers**: every provider call carries `sha256(user_id)` — OpenAI
  `safety_identifier` param; Google/fal as request metadata where supported. Provider
  penalties attribute to the end user, not the org key.
- Charge unchanged (RPC, advisory lock); items now `status='pending'`, `media_url`
  empty until completion (DTO exposes null-safe placeholder state).

## 3. Provider adapters

```typescript
interface ProviderAdapter {
  submit(ctx: { prompt; settings; referencePath?; maskPng?; safetyId }): Promise<string>; // provider_ref
  check(providerRef: string): Promise<
    { state: 'running' } | { state: 'done'; imageUrl: string } | { state: 'failed'; error: string }>;
}
```

- **fal** (`flux`, `seedream`, upscaler): queue API — submit → `request_id`; check →
  status/result endpoints. Image-to-image via reference URL (signed URL of stored
  upload). Model slugs: FLUX.2 pro, Seedream v4 text-to-image / edit, clarity-upscaler.
- **google** (`nano-banana` fast/standard/pro → gemini-2.5-flash-image /
  gemini-3.1-flash-image / gemini-3-pro-image): generateContent with `image_size`
  (1K/2K/4K uppercase), aspect ratio, inline reference image for edits. Often completes
  inline → adapter stores result immediately and check() short-circuits to done.
- **openai** (`gpt-image` 1/1.5/2): images generate + edits (mask PNG from the editor
  finally rides along), `quality` low/medium/high, `size` mapped from aspect+resolution,
  `safety_identifier`.
- Exact request/response field mapping is resolved against current provider docs during
  implementation planning; the adapter interface above is the contract.

## 4. Jobs + polling + storage

**`GET /jobs?ids=a,b,c`** (gateway): for each owned pending job → adapter.check():
- running → return pending
- done → download output → upload to private bucket `media/{userId}/{generationId}.png`
  → set `generations.media_path`, status done → return item with fresh signed URL
- failed → status failed, `jobs.error` saved, **refund ledger entry** (type `refund`,
  amount = item price, note = family + reason)

Signed URLs: 7-day expiry, minted by the gateway on every list/fetch (`media_url` in
DTOs is always a signed URL derived from `media_path`). Direct bucket access denied
(private buckets, no policies).

Client polling: only while pending jobs exist; 2s interval first 30s, then 5s.
Timeout sweep: pg_cron `fail_stale_jobs` every 5 min — jobs pending > 10 min → failed +
refund (SQL calls a `fn_fail_job` RPC to keep refund logic atomic and single-sourced).
Purge cron extended: delete Storage objects (via gateway-invoked cleanup or storage API
from a scheduled function) before deleting rows.

## 5. Kill switch (`models` table)

```sql
models (id text primary key,   -- family ids incl. video + 'upscaler'
        enabled boolean not null default true,
        updated_at timestamptz)
```
Seeded: image families + upscaler = true; video families = false (3b flips them).
Dispatch checks; disabled → 503 `model_disabled`. Frontend: `GET /models` merged into
catalog → disabled families render greyed "Temporarily unavailable" (video shows
"Coming soon"). One SQL isolates any provider mid-incident.

## 6. Uploads (reference images)

- `POST /uploads` (gateway, multipart): 10MB cap, mime-sniffed image types only
  (png/jpeg/webp), stored `uploads/{userId}/{uuid}` in private bucket.
- **Moderated at upload**: image through omni-moderation; flagged → 422 + strike +
  `moderation_events` row storing a copy at `quarantine/{userId}/{uuid}` (evidence for
  appeals; not user-accessible).
- Response `{ uploadId, url }` (signed preview). Rail Upload button un-greys; uploaded
  reference usable as edit source (`referenceUploadId` on POST /generations; edits
  accept either `parentId` or `referenceUploadId`).

## 7. Schema (migration 0004)

```sql
create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  generation_id uuid not null references public.generations on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,  -- one-hop debugging
  provider text not null check (provider in ('google','openai','fal')),
  provider_ref text,
  attempts int not null default 0,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index jobs_user_idx on public.jobs (user_id, created_at desc);
create index jobs_generation_idx on public.jobs (generation_id);

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
  quarantine_path text,           -- copy of flagged upload, evidence for appeals
  categories jsonb not null,      -- moderation categories + scores (the AI's reasoning)
  resolution text,                -- null = unreviewed; 'upheld' | 'overturned' + note
  created_at timestamptz not null default now()
);

alter table public.generations add column media_path text;   -- storage path; media_url derived

-- Atomic failure: marks generation failed, records the job error, inserts exactly one
-- refund ledger entry (guarded by a unique partial index on (type, note-ref) semantics:
-- refund carries stripe_ref-style uniqueness via note key 'refund:<generation_id>'
-- enforced with a unique index on ledger_entries ((note)) where type = 'refund').
create or replace function public.fn_fail_job(p_job uuid, p_error text) returns void;
-- RLS enabled deny-all on all three; execute revoked per gateway posture; grants to service_role.
-- Storage: private buckets 'media', 'uploads' (+ quarantine prefix), no public policies.
```

Debug query (documented in runbook): jobs join generations join profiles → every
failure shows user, prompt, provider, raw error, refund status in one row.

**Suspension**: derived — `profiles.strikes >= 2` blocks dispatch and uploads.
Reinstatement runbook: review `moderation_events` for the user; if wrongly flagged →
`update profiles set strikes = strikes - N`; record outcome in
`moderation_events.resolution`. Admin UI later; SQL runbook for MVP.

## 8. Frontend

- Pending cards: real spinner state until poll flips them; failed cards show reason +
  "Refunded $X" + Retry (re-submits same request).
- JobPoller service: watches store for pending items, polls `GET /jobs`, applies
  updates, backs off, stops when none pending.
- 422 content_policy → firm notice ("This prompt violates our content policy. Strike
  N of 2."); 429 account_suspended → suspension screen with appeal contact.
- Upload button live (10MB, progress, moderated).
- Disabled families greyed from `GET /models` ("Coming soon" for video).
- Library media now signed URLs (transparent to components — DTO shape unchanged).

## 9. Config + user actions

Supabase Edge Function secrets: `GOOGLE_AI_API_KEY` (aistudio.google.com, free tier),
`OPENAI_API_KEY` (platform.openai.com, ~$5 funding; powers moderation too),
`FAL_API_KEY` (fal.ai, ~$10 deposit). Storage buckets created via gateway migration
step (MCP/API). No repo keys ever.

## 10. Verification (real spend, < $0.50 total)

One real generation per family (Nano Banana Fast, Seedream, FLUX, GPT low) + GPT masked
edit + fal upscale + reference-image edit from an upload. Moderation drill: violating
prompt → 422, strike, moderation_events row, no charge, no provider call (provider
dashboards show zero requests). Second violation → suspended, dispatch 429; SQL
reinstate drill → dispatch works again, resolution recorded. Kill-switch flip drill.
Forced failure → refund row exact. Timeout sweep dry-run. Signed URL loads; direct
bucket URL 403s. Full vitest + build green.

## 11. Out of scope

Video families (3b — same adapters pattern + Runway). Magnific premium tier. Admin
appeals UI (SQL runbook now). Per-user rate limiting beyond suspension (revisit at
launch with CAPTCHA). Hosting (phase 4).
